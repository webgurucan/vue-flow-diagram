<template>
  <div id="app">
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :default-viewport="{ zoom: 1 }"
      :min-zoom="0.2"
      :max-zoom="4"
      class="vue-flow-container"
    >
      <Background />
      <Controls />
    </VueFlow>
  </div>
</template>

<script>
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import dagre from 'dagre'
import { NODE_WIDTH, NODE_HEIGHT, initialGraphData } from './data'

export default {
  name: 'App',
  components: {
    VueFlow,
    Background,
    Controls
  },
  data() {
    return {
      nodes: [],
      edges: [],
      subGraphCounter: 0,
      NODE_GAP: 50,
      RANK_GAP: 80,
      CONTAINER_PADDING: 20,
      CONTAINER_CHILD_GAP: 50
    }
  },
  mounted() {
    this.addSubGraph(initialGraphData)
    this.addSubGraph(initialGraphData)
    this.addSubGraph(initialGraphData)
    this.addSubGraph(initialGraphData)
  },
  methods: {
    /**
     * Add a sub graph to the canvas
     * @param {Object} graphData - { nodes: [], edges: [], containers: [] }
     */
    addSubGraph(graphData) {
      const prefix = `subgraph_${this.subGraphCounter++}_`
      const { nodes: newNodes = [], edges: newEdges = [], containers: newContainers = [] } = graphData

      // Apply prefix to all IDs
      const prefixNodes = newNodes.map(node => ({
        ...node,
        id: `${prefix}${node.id}`
      }))

      const prefixEdges = newEdges.map(edge => ({
        source: `${prefix}${edge.source}`,
        target: `${prefix}${edge.target}`
      }))

      const prefixContainers = newContainers.map(container => ({
        id: `${prefix}${container.id}`,
        childIds: container.childIds.map(childId => `${prefix}${childId}`)
      }))

      // Step 1: Find individual nodes (not in containers)
      const individualNodes = prefixNodes.filter(node => {
        return !prefixContainers.some(container => container.childIds.includes(node.id))
      })

      // Step 2: Find root node (node with no incoming edges)
      const rootNode = individualNodes.find(node => {
        return !prefixEdges.some(edge => edge.target === node.id)
      })

      if (!rootNode) {
        console.error('No root node found')
        return
      }

      // Step 3: Layout individual nodes using Dagre (excluding containers)
      const individualEdges = prefixEdges.filter(edge => {
        const sourceIsIndividual = individualNodes.some(n => n.id === edge.source)
        const targetIsIndividual = individualNodes.some(n => n.id === edge.target)
        return sourceIsIndividual && targetIsIndividual
      })

      const individualPositions = this.layoutNodesWithDagre(individualNodes, individualEdges)

      // Step 4: Layout failure container children
      const failureContainer = prefixContainers.find(c => c.id.includes('failure'))
      const failureLayout = failureContainer
        ? this.layoutContainerChildren(failureContainer, prefixNodes, prefixEdges)
        : null

      // Step 5: Layout success container children
      const successContainer = prefixContainers.find(c => c.id.includes('success'))
      const successLayout = successContainer
        ? this.layoutContainerChildren(successContainer, prefixNodes, prefixEdges)
        : null

      // Step 6: Calculate offset to place sub graph in free space
      const offset = this.calculateSubGraphOffset(individualPositions, failureLayout, successLayout)

      // Step 7: Position failure container (left, first child level)
      const failureContainerPos = failureLayout
        ? this.positionFailureContainer(individualPositions, rootNode, failureLayout, offset)
        : null

      // Step 8: Position success container (right, first child level)
      const successContainerPos = successLayout
        ? this.positionSuccessContainer(individualPositions, rootNode, successLayout, offset, failureContainerPos, failureLayout, prefixEdges)
        : null

      // Step 9: Build and add nodes to canvas
      const flowNodes = [...this.nodes]
      const flowEdges = [...this.edges]

      // Add individual nodes with offset
      individualNodes.forEach(node => {
        const pos = individualPositions.get(node.id)
        if (pos) {
          flowNodes.push({
            id: node.id,
            type: 'default',
            position: {
              x: pos.x + offset.x,
              y: pos.y + offset.y
            },
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            data: { label: node.id.replace(prefix, '') },
            draggable: true
          })
        }
      })

      // Add failure container and children
      if (failureContainer && failureContainerPos && failureLayout) {
        flowNodes.push({
          id: failureContainer.id,
          type: 'default',
          position: failureContainerPos,
          width: failureLayout.size.width,
          height: failureLayout.size.height,
          style: {
            width: `${failureLayout.size.width}px`,
            height: `${failureLayout.size.height}px`,
            border: '2px solid #6366f1',
            borderRadius: '8px',
            background: 'rgba(99, 102, 241, 0.1)'
          },
          data: { label: 'failure' },
          selectable: true,
          draggable: true
        })

        // Add failure container children
        // Note: When parentNode is set, positions are relative to parent, not absolute
        failureContainer.childIds.forEach(childId => {
          const childPos = failureLayout.positions.get(childId)
          if (childPos) {
            flowNodes.push({
              id: childId,
              type: 'default',
              position: {
                x: childPos.x,  // Relative to container (0,0)
                y: childPos.y   // Relative to container (0,0)
              },
              data: { label: childId.replace(prefix, '') },
              parentNode: failureContainer.id,
              extent: 'parent',
              draggable: false
            })
          }
        })
      }

      // Add success container and children
      if (successContainer && successContainerPos && successLayout) {
        flowNodes.push({
          id: successContainer.id,
          type: 'default',
          position: successContainerPos,
          width: successLayout.size.width,
          height: successLayout.size.height,
          style: {
            width: `${successLayout.size.width}px`,
            height: `${successLayout.size.height}px`,
            border: '2px solid #6366f1',
            borderRadius: '8px',
            background: 'rgba(99, 102, 241, 0.1)'
          },
          data: { label: 'success' },
          selectable: true,
          draggable: true
        })

        // Add success container children
        // Note: When parentNode is set, positions are relative to parent, not absolute
        successContainer.childIds.forEach(childId => {
          const childPos = successLayout.positions.get(childId)
          if (childPos) {
            flowNodes.push({
              id: childId,
              type: 'default',
              position: {
                x: childPos.x,  // Relative to container (0,0)
                y: childPos.y   // Relative to container (0,0)
              },
              data: { label: childId.replace(prefix, '') },
              parentNode: successContainer.id,
              extent: 'parent',
              draggable: false
            })
          }
        })
      }

      // Add edges (filter out edges between container children in same container)
      const addedEdgeIds = new Set(this.edges.map(e => e.id))
      prefixEdges.forEach(edge => {
        const edgeId = `edge-${edge.source}-${edge.target}`

        // Check if both nodes exist
        const sourceExists = flowNodes.some(n => n.id === edge.source)
        const targetExists = flowNodes.some(n => n.id === edge.target)

        if (!sourceExists || !targetExists) return

        // Filter edges between container children in same container (unless explicit)
        const sourceNode = flowNodes.find(n => n.id === edge.source)
        const targetNode = flowNodes.find(n => n.id === edge.target)

        if (sourceNode?.parentNode && targetNode?.parentNode &&
            sourceNode.parentNode === targetNode.parentNode) {
          const originalSource = edge.source.replace(prefix, '')
          const originalTarget = edge.target.replace(prefix, '')
          const hasExplicitEdge = newEdges.some(e =>
            e.source === originalSource && e.target === originalTarget
          )
          if (!hasExplicitEdge) return
        }

        if (!addedEdgeIds.has(edgeId)) {
          flowEdges.push({
            id: edgeId,
            source: edge.source,
            target: edge.target,
            type: 'bezier',
            animated: false
          })
          addedEdgeIds.add(edgeId)
        }
      })

      this.nodes = flowNodes
      this.edges = flowEdges
    },

    /**
     * Layout nodes using Dagre algorithm (independent positioning)
     */
    layoutNodesWithDagre(nodes, edges) {
      if (nodes.length === 0) return new Map()

      const g = new dagre.graphlib.Graph()
      g.setDefaultEdgeLabel(() => ({}))
      g.setGraph({
        rankdir: 'TB',
        nodesep: this.NODE_GAP,
        ranksep: this.RANK_GAP
      })

      // Add nodes with fixed size
      nodes.forEach(node => {
        g.setNode(node.id, {
          width: NODE_WIDTH,
          height: NODE_HEIGHT
        })
      })

      // Add edges
      edges.forEach(edge => {
        g.setEdge(edge.source, edge.target)
      })

      // Run layout
      dagre.layout(g)

      // Extract positions (Dagre gives center, convert to top-left)
      const positions = new Map()
      g.nodes().forEach(nodeId => {
        const node = g.node(nodeId)
        if (node.x !== undefined && node.y !== undefined) {
          positions.set(nodeId, {
            x: node.x - NODE_WIDTH / 2,
            y: node.y - NODE_HEIGHT / 2
          })
        }
      })

      return positions
    },

    /**
     * Layout container children using Dagre
     */
    layoutContainerChildren(container, allNodes, allEdges) {
      const childNodes = allNodes.filter(n => container.childIds.includes(n.id))
      const childEdges = allEdges.filter(e =>
        container.childIds.includes(e.source) && container.childIds.includes(e.target)
      )

      if (childNodes.length === 0) {
        return {
          positions: new Map(),
          size: { width: NODE_WIDTH, height: NODE_HEIGHT }
        }
      }

      const g = new dagre.graphlib.Graph()
      g.setDefaultEdgeLabel(() => ({}))
      g.setGraph({
        rankdir: 'TB',
        nodesep: this.CONTAINER_CHILD_GAP,
        ranksep: this.CONTAINER_CHILD_GAP
      })

      // Add nodes with fixed size
      childNodes.forEach(node => {
        g.setNode(node.id, {
          width: NODE_WIDTH,
          height: NODE_HEIGHT
        })
      })

      // Add edges
      childEdges.forEach(edge => {
        g.setEdge(edge.source, edge.target)
      })

      // Run layout
      dagre.layout(g)

      // Extract positions and calculate bounds
      const positions = new Map()
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity

      g.nodes().forEach(nodeId => {
        const node = g.node(nodeId)
        if (node.x !== undefined && node.y !== undefined) {
          const x = node.x - NODE_WIDTH / 2
          const y = node.y - NODE_HEIGHT / 2

          positions.set(nodeId, { x, y })

          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x + NODE_WIDTH)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y + NODE_HEIGHT)
        }
      })

      // Calculate container size with padding
      const width = (maxX - minX) + (this.CONTAINER_PADDING * 2)
      const height = (maxY - minY) + (this.CONTAINER_PADDING * 2)

      // Adjust positions relative to container top-left (with padding)
      const adjustedPositions = new Map()
      positions.forEach((pos, nodeId) => {
        adjustedPositions.set(nodeId, {
          x: pos.x - minX + this.CONTAINER_PADDING,
          y: pos.y - minY + this.CONTAINER_PADDING
        })

      })

      return {
        positions: adjustedPositions,
        size: { width, height }
      }
    },

    /**
     * Calculate offset to place sub graph in free space (bottom right, going down)
     */
    calculateSubGraphOffset(individualPositions, failureLayout, successLayout) {
      // Find bounds of new sub graph (before offset)
      let minX = Infinity
      let minY = Infinity

      // Check individual nodes
      individualPositions.forEach(pos => {
        minX = Math.min(minX, pos.x)
        minY = Math.min(minY, pos.y)
      })

      // Get bounds of existing nodes
      const existingMaxY = this.getMaxY()
      const existingMaxX = this.getMaxX()

      // Calculate offset: place below existing nodes, align to right
      const offsetX = existingMaxX > 0 ? existingMaxX + this.NODE_GAP - minX : -minX
      const offsetY = existingMaxY > 0 ? existingMaxY + this.RANK_GAP - minY : (minY < 0 ? -minY : 0)

      return { x: offsetX, y: offsetY }
    },

    /**
     * Position failure container to the left, at first child level
     */
    positionFailureContainer(individualPositions, rootNode, failureLayout, offset) {
      const rootPos = individualPositions.get(rootNode.id)
      if (!rootPos) return null

      // Find level 1 nodes (direct children of root)
      const level1Y = rootPos.y + NODE_HEIGHT + this.RANK_GAP

      // Position to the left of the graph
      const graphLeftX = this.getGraphLeftX(individualPositions, offset)
      const failureX = graphLeftX - failureLayout.size.width - this.NODE_GAP

      return {
        x: failureX + offset.x,
        y: level1Y + offset.y
      }
    },

    /**
     * Position success container to the right, at first child level
     */
    positionSuccessContainer(individualPositions, rootNode, successLayout, offset, failureContainerPos, failureLayout, prefixEdges) {
      const rootPos = individualPositions.get(rootNode.id)
      if (!rootPos) return null

      // Find level 1 nodes (direct children of root) by checking edges
      const level1NodeIds = new Set()
      prefixEdges.forEach(edge => {
        if (edge.source === rootNode.id) {
          level1NodeIds.add(edge.target)
        }
      })

      // Find level 1 Y position (should be same for all level 1 nodes)
      const level1Y = rootPos.y + NODE_HEIGHT + this.RANK_GAP

      // Calculate rightmost X of ALL individual nodes (AFTER offset is applied)
      // This ensures success container is to the right of the entire graph
      let graphRightX = (rootPos.x + offset.x) + NODE_WIDTH

      individualPositions.forEach((pos, nodeId) => {
        const absoluteX = pos.x + offset.x
        graphRightX = Math.max(graphRightX, absoluteX + NODE_WIDTH)
      })

      // Position success container to the right of the graph's individual nodes
      let successX = graphRightX + this.NODE_GAP

      // Check for collision with failure container (if in same graph)
      if (failureContainerPos && failureLayout) {
        const failureRightX = failureContainerPos.x + failureLayout.size.width
        // Only adjust if failure is actually to the right of our calculated position
        // (This shouldn't happen normally since failure is on the left, but just in case)
        if (failureRightX > successX) {
          successX = failureRightX + this.NODE_GAP
        }
      }

      return {
        x: successX,
        y: level1Y + offset.y
      }
    },

    /**
     * Get leftmost X position of graph
     */
    getGraphLeftX(individualPositions, offset) {
      let minX = Infinity
      individualPositions.forEach(pos => {
        minX = Math.min(minX, pos.x)
      })
      return minX === Infinity ? 0 : minX
    },

    /**
     * Get rightmost X position of graph
     */
    getGraphRightX(individualPositions, offset) {
      let maxX = -Infinity
      individualPositions.forEach(pos => {
        maxX = Math.max(maxX, pos.x + NODE_WIDTH)
      })
      return maxX === -Infinity ? 0 : maxX
    },

    /**
     * Get maximum X position of existing nodes at a specific Y level (within tolerance)
     */
    getMaxXAtLevel(targetY, tolerance = 100) {
      if (this.nodes.length === 0) return 0

      let maxX = -Infinity
      this.nodes.forEach(node => {
        if (!node.parentNode) {
          const nodeY = node.position.y
          // Check if node is at similar Y level (same rank)
          if (Math.abs(nodeY - targetY) <= tolerance) {
            const width = node.width || (node.style?.width ? parseInt(node.style.width) : NODE_WIDTH)
            maxX = Math.max(maxX, node.position.x + width)
          }
        }
      })
      return maxX === -Infinity ? 0 : maxX
    },

    /**
     * Get maximum Y position of existing nodes
     */
    getMaxY() {
      if (this.nodes.length === 0) return 0

      let maxY = 0
      this.nodes.forEach(node => {
        if (!node.parentNode) {
          const height = node.height || (node.style?.height ? parseInt(node.style.height) : NODE_HEIGHT)
          maxY = Math.max(maxY, node.position.y + height)
        }
      })
      return maxY
    },

    /**
     * Get maximum X position of existing nodes
     */
    getMaxX() {
      if (this.nodes.length === 0) return 0

      let maxX = -Infinity
      this.nodes.forEach(node => {
        if (!node.parentNode) {
          const width = node.width || (node.style?.width ? parseInt(node.style.width) : NODE_WIDTH)
          maxX = Math.max(maxX, node.position.x + width)
        }
      })
      return maxX === -Infinity ? 0 : maxX
    }
  }
}
</script>

<style>
#app {
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0;
}

.vue-flow-container {
  width: 100%;
  height: 100%;
  background: #f8fafc;
}

/* Vue Flow default node styles */
.vue-flow__node {
  font-weight: 600;
  color: #1f2937;
}

.vue-flow__node-default {
  background: white;
  border: 2px solid #6366f1;
  border-radius: 8px;
  padding: 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.vue-flow__node-group {
  background: rgba(99, 102, 241, 0.05);
}

/* Vue Flow edge styles */
.vue-flow__edge-path {
  stroke: #6366f1;
  stroke-width: 2;
}

.vue-flow__edge.selected .vue-flow__edge-path {
  stroke: #4f46e5;
  stroke-width: 3;
}
</style>
