'use strict'

const _ = require('lodash')
const uuid = require('uuid/v4')
const request = require('request')
const express = require('express')
const bodyParser = require('body-parser')

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
      messageId: messageId,
      originator: details.originator,
      text: details.text,
      endpoint: this.endpoint
    }
    this.seen[this.uuid] = this.sequenceNum()
  }

  propogateMessage() {
    const peer = this.randomPeer()
    if(!peer) return
    let message

    if(Math.random() > 0) {
      // pick a random origin with messages we haven't yet sent to the randomly selected peer
      const messageOrigin = _.sample(this.originsWithUnsentMessages(peer))
      if(!messageOrigin) return // <- peer is up-to-date
      // console.log([messageOrigin, (peer.seen[messageOrigin] || 0) + 1].join(':'))
      // let's send the peer the next message in the sequence, after the most recent message they saw
      message = this.rumor([messageOrigin, (peer.seen[messageOrigin] || 0) + 1].join(':'))
    } else {
      message = this.want()
    }

    this.send(message, peer)
  }

  rumor(messageId) {
    return { rumor: this.messages[messageId], endpoint: this.endpoint }
  }

  want(messageId) {
    return { want: this.seen, endpoint: this.endpoint }
  }

  parseId(messageId) {
    let [originId, sequenceNum] = messageId.split(':')
    return [originId, parseInt(sequenceNum, 10)]
  }

  send(message, peer) {
    if(message.rumor) {
      const [originId, sequenceNum] = this.parseId(message.rumor.messageId)
      peer.seen[originId] = sequenceNum
    }

    request.post(peer.endpoint, { json: message })
  }

  originsWithUnsentMessages(peer) {
    const untrackedNodes = _.difference(_.keys(this.seen), _.keys(peer.seen))

    const nodesWithUnsentMessages = _.keys(_.pickBy(peer.seen, (messageNum, nodeId) => {
      return this.seen[nodeId] > messageNum
    }))

    return (untrackedNodes.concat(nodesWithUnsentMessages))
  }

  receiveMessage(message) {
    if(message.want) return
    const messageContent = (message.rumor || message.want)
    let [originId, sequenceNum] = this.parseId(messageContent.messageId)
    sequenceNum = parseInt(sequenceNum, 10)

    if(this.seen[originId] > sequenceNum) return // we've already a newer message than this, we can ignore it
    this.messages[messageContent.messageId] = messageContent
    this.seen[originId] = sequenceNum
  }
}

let nodes = []
_.range(0, 3).forEach(n => {
  let port = 3010 + n
  let server = express()
  server.use(bodyParser.json())

  server.listen(port, () => {
    console.log('Example app listening on port ' + port)
  })

  nodes.push(new Node('http://localhost:' + port + '/receive'))
  if(nodes[n - 1]) nodes[n].addPeer(nodes[n - 1])

  server.post('/receive', function (req, res) {
    nodes[n].receiveMessage(req.body)
    res.sendStatus(200)
  })

  setInterval(nodes[n].propogateMessage.bind(nodes[n]), 500)
})

// console.log(nodes.length)

// let nodeA = new Node('http://localhost:3010/receive')
// let nodeB = new Node('http://localhost:3011/receive')
nodes[2].newMessage({ text: 'a', originator: 'Alex' })


setInterval(nodes[2].propogateMessage.bind(nodes[2]), 500)

// nodeA.newMessage({ text: 'b', originator: 'Fred' })
// nodeA.addPeer(nodeB)

// setTimeout(nodeA.propogateMessage.bind(nodeA), 500)
// setTimeout(nodeA.propogateMessage.bind(nodeA), 1500)

// server.post('/receive', function (req, res) {
//   nodeB.receiveMessage(req.body)
//   console.log(nodeB)
//   res.send("Hello");
// })

// server.listen(3011, function () {
//   console.log('Example app listening on port 3011!')
// })
