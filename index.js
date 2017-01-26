'use strict'

const _ = require('lodash')
const uuid = require('uuid/v4')
const request = require('request')
const path = require('path')
const express = require('express')
const http = require('http')
const bodyParser = require('body-parser')
const WebSocket = require('ws')
const process = require('process')
const Q = require('q')

// Config constants
const numNodes = 3
const refreshFrequencyMs = 200
const baseUrl = 'http://localhost'

class Node {
  constructor(endpoint) {
    if(!endpoint || !endpoint.startsWith('http')) throw("Node must be initialized with a valid endpoint URI")

    this.endpoint = endpoint
    this.uuid = uuid()

    this.peers = []
    this.seen = {}
    this.messages = {}
  }

  addPeer(peer) {
    this.peers.push(peer)
  }

  findOrCreatePeer(endpoint) {
    return _.find(this.peers, { endpoint: endpoint }) || this.addPeer(new Node(endpoint))
  }

  randomPeer() {
    return _.sample(this.peers)
  }

  sequenceNum() {
    const myMessageIds = _.keys(this.messages).filter(messageId => messageId.startsWith(this.uuid))
    return _.max(myMessageIds.map(messageId => parseInt(messageId.split(':')[1]), 10)) || 0
  }

  newMessage(details) {
    const messageId = [this.uuid, this.sequenceNum() + 1].join(':')

    this.messages[messageId] = {
      MessageID: messageId,
      Originator: details.Originator,
      Text: details.Text,
      EndPoint: this.endpoint
    }
    this.seen[this.uuid] = this.sequenceNum()
    return messageId
  }

  propogateMessage() {
    const peer = this.randomPeer()
    if(!peer) return
    let message

    if(Math.random() > 0.5) {
      // pick a random origin with messages we haven't yet sent to the randomly selected peer
      const messageOrigin = _.sample(this.originsWithUnseenMessages(peer.seen))
      if(!messageOrigin) return // <- peer is up-to-date

      // let's send the peer the next message in the sequence, after the most recent message they saw
      message = this.nextMessage(messageOrigin, peer.seen)
    } else {
      message = this.want()
    }

    this.send(message, peer)
  }

  nextMessage(messageOrigin, seenMessages) {
    return this.rumor([messageOrigin, (seenMessages[messageOrigin] || 0) + 1].join(':'))
  }

  rumor(messageId) {
    return { Rumor: this.messages[messageId], EndPoint: this.endpoint }
  }

  want(messageId) {
    return { Want: this.seen, EndPoint: this.endpoint }
  }

  parseId(messageId) {
    let [originId, sequenceNum] = messageId.split(':')
    return [originId, parseInt(sequenceNum, 10)]
  }

  send(message, peer) {
    request.post(peer.endpoint, { json: message }, (error, response) => {
      if (!error && response.statusCode == 200 && message.Rumor) {
        const [originId, sequenceNum] = this.parseId(message.Rumor.MessageID)
        if(peer) peer.seen[originId] = sequenceNum
      }
    })
  }

  originsWithUnseenMessages(seenMessages) {
    const untrackedNodes = _.difference(_.keys(this.seen), _.keys(seenMessages))

    const nodesWithUnsentMessages = _.keys(_.pickBy(seenMessages, (messageNum, nodeId) => {
      return this.seen[nodeId] > messageNum
    }))

    return (untrackedNodes.concat(nodesWithUnsentMessages))
  }

  receiveMessage(message) {
    const messageContent = (message.Rumor || message.Want)
    let peer = this.findOrCreatePeer(message.EndPoint)

    if(message.Want) {
      this.originsWithUnseenMessages(message.Want).forEach(messageOrigin => {
        this.send(this.nextMessage(messageOrigin, message.Want), peer)
      })
    } else if(message.Rumor) {
      let [originId, sequenceNum] = this.parseId(messageContent.MessageID)
      sequenceNum = parseInt(sequenceNum, 10)

      if(this.seen[originId] > sequenceNum) return // we've already a newer message than this, we can ignore it
      this.messages[messageContent.MessageID] = messageContent
      this.seen[originId] = sequenceNum
      if(messageContent.Text == 'secret') console.log(message, this.messages)
      return messageContent
    } else {
      // something else, ignore...
    }
  }
}

let socketServers = []
let nodes = []
_.range(0, 3).forEach(n => {
  let port = 3010 + n
  let app = express()
  app.use(bodyParser.json())

  nodes.push(new Node([baseUrl, port].join(':') + '/gossip'))

  const server = http.createServer(app)
  const wss = new WebSocket.Server({ server })
  socketServers.push(wss)

  app.post('/gossip', (req, res) => {
    if(nodes[n].stopped) {
      res.sendStatus(503)
    } else {
      let newMessage = nodes[n].receiveMessage(req.body)
      if(newMessage) {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ [newMessage.MessageID]: newMessage }))
          }
        })
      }

      res.sendStatus(200)
    }
  })

  app.post('/message', (req, res) => {
    let messageId = nodes[n].newMessage(req.body)

    res.setHeader('Content-Type', 'application/json')
    res.send(JSON.stringify({ MessageID: messageId }))
  })

  app.post('/nodes', (req, res) => {
    nodes[n].findOrCreatePeer(req.body.endpoint)
    res.sendStatus(200)
  })

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'))
  })
  app.on('upgrade', wss.handleUpgrade);

  wss.on('connection', ws => {
    ws.send(JSON.stringify(nodes[n].messages))
  })

  server.listen(port, () => {
    console.log(`Node ${ n + 1 } (Origin ID: ${ nodes[n].uuid }) listening on ${ nodes[n].endpoint.replace('/gossip', '') }`)
  })
  setInterval(nodes[n].propogateMessage.bind(nodes[n]), refreshFrequencyMs)
})

nodes.forEach(node => {
  _.without(nodes, node).forEach(partner => node.addPeer(partner))
})

setTimeout(() => { console.log("To stop a node, enter `stop n`. To start a stopped node, enter `start n`") }, 200)

process.openStdin().addListener('data', d => {
  const input = d.toString().trim()
  let commandParse = input.match(/^(start|stop) ([0-9]+)/)
  let match, command, nodeNum
  
  if(commandParse) {
    [match, command, nodeNum] = commandParse
  } else {
    console.log(`Unrecognized command ${ input }`)
    return
  }

  nodeNum = parseInt(nodeNum, 10) - 1
  nodes[nodeNum].stopped = (command == 'stop')
  console.log(`Node ${ nodeNum + 1 } has been ${ command == 'stop' ? 'stopped' : 'started' }`)
})

process.once('SIGUSR2', function () {
  const activeClients = _.flatten(socketServers.map(s => s.clients)).filter(client => client.readyState === WebSocket.OPEN)

  Q.all(activeClients.map(client => {
    let deferred = Q.defer()
    client.send(JSON.stringify({ refresh: true }), {}, data => deferred.resolve(data))
    return deferred
  })).then(() => {
    setTimeout(() => { process.kill(process.pid, 'SIGUSR2') }, 200)
  })
})