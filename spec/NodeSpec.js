'use strict'

describe('Node', () => {
  const Node = require('../Node')
  let node

  beforeEach(() => {
    node = new Node('http://localhost:1001')
  })

  it('should have a uuid', () => {
    expect(node.uuid).toMatch(/[a-z0-9-]{36}/)
  })

  it('should have a endpoint', () => {
    expect(node.endpoint).toMatch(/https?:\/\//)
  })

  it('can add peers', () => {
    nodeB = new Node('http://localhost:1001')

    expect(node.peers).toEqual([nodeB])
  })

})
