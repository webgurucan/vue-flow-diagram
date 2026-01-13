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
      graphInstanceCounter: 0,
      NODE_GAP: 50,
      RANK_GAP: 80,
      CONTAINER_PADDING: 20,
      CONTAINER_CHILD_GAP: 50
    }
  },
  async mounted() {
    await this.addToGraph(initialGraphData)
    await this.addToGraph(initialGraphData)
    await this.addToGraph(initialGraphData)
  },
  methods: {
    /**
     * Add a graph to the canvas with optional prefix
     * @param {Object} graphData - { nodes: [], edges: [], containers: [] }
     * @param {String} prefix - Optional prefix for IDs
     */
    async addToGraph(graphData, prefix = null) {
      // Generate prefix if not provided
      if (prefix === null) {
        prefix = `graph_${this.graphInstanceCounter++}_`
      }

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

      // Get existing node IDs
      const existingNodeIds = new Set(this.nodes.map(n => n.id))
      const existingContainerIds = new Set(
        this.nodes.filter(n => n.style?.border).map(n => n.id)
      )

      // Filter new items
      const nodesToAdd = prefixNodes.filter(n => !existingNodeIds.has(n.id))
      const containersToAdd = prefixContainers.filter(c => !existingContainerIds.has(c.id))

      console.log('Adding graph:', {
        prefix,
        nodesToAdd: nodesToAdd.length,
        containersToAdd: containersToAdd.length
      })

      // Step 1a: Layout individual nodes first (without containers)
      const individualNodes = nodesToAdd.filter(node => {
        return !containersToAdd.some(container => container.childIds.includes(node.id))
      })

      const individualEdges = prefixEdges.filter(edge => {
        const sourceIsIndividual = individualNodes.some(n => n.id === edge.source)
        const targetIsIndividual = individualNodes.some(n => n.id === edge.target)
        return sourceIsIndividual && targetIsIndividual
      })

      const individualPositions = this.layoutWithDagre(individualNodes, individualEdges)

      // Step 1b: Find root node and level 1 nodes
      const rootNode = individualNodes.find(node => {
        return !prefixEdges.some(edge => edge.target === node.id)
      })

      // Get level 1 nodes (direct children of root)
      const level1Nodes = individualNodes.filter(node => {
        return prefixEdges.some(edge => edge.source === rootNode?.id && edge.target === node.id)
      })

      // Step 1c: Position containers as level 1 (below root, same row as other level 1 nodes)
      const containerPositionsFromLayout = new Map()

      if (rootNode && containersToAdd.length > 0) {
        // Get root position
        const rootPos = individualPositions.get(rootNode.id)
        if (rootPos) {
          // Get Y position for level 1 (below root)
          let level1Y = rootPos.y + NODE_HEIGHT + this.RANK_GAP

          // Check if there are level 1 nodes to align with
          if (level1Nodes.length > 0) {
            const firstLevel1Pos = individualPositions.get(level1Nodes[0].id)
            if (firstLevel1Pos) {
              level1Y = firstLevel1Pos.y
            }
          }

          // Find rightmost level 1 node to position containers to the right
          let rightmostX = rootPos.x
          if (level1Nodes.length > 0) {
            level1Nodes.forEach(node => {
              const pos = individualPositions.get(node.id)
              if (pos) {
                rightmostX = Math.max(rightmostX, pos.x + NODE_WIDTH)
              }
            })
          }

          // Start positioning containers to the right of level 1 nodes
          let containerX = rightmostX + this.NODE_GAP

          // Place containers horizontally
          containersToAdd.forEach((container) => {
            // Use estimated size for initial positioning (will be adjusted later)
            const estimatedWidth = NODE_WIDTH * 2
            containerPositionsFromLayout.set(container.id, {
              x: containerX,
              y: level1Y
            })
            // Move X for next container
            containerX += estimatedWidth + this.NODE_GAP
          })
        }
      }

      // Step 2: Layout container children using Dagre to get actual container sizes
      const containerChildrenPositions = new Map()
      const containerSizes = new Map()

      for (const container of containersToAdd) {
        const childNodes = nodesToAdd.filter(n => container.childIds.includes(n.id))
        const childEdges = prefixEdges.filter(e =>
          container.childIds.includes(e.source) && container.childIds.includes(e.target)
        )

        if (childNodes.length > 0) {
          const childrenLayout = this.layoutContainerChildrenWithDagre(childNodes, childEdges)
          containerChildrenPositions.set(container.id, childrenLayout.positions)
          containerSizes.set(container.id, childrenLayout.size)
        }
      }

      // Step 3: Calculate offset to place graph in free space (using actual container sizes)
      const offset = this.calculateGraphOffset(individualPositions, containerPositionsFromLayout, containerSizes)

      // Step 4: Apply offset to all positions
      const offsetIndividualPositions = new Map()
      individualPositions.forEach((pos, nodeId) => {
        offsetIndividualPositions.set(nodeId, {
          x: pos.x + offset.x,
          y: pos.y + offset.y
        })
      })

      // Update container positions with offset and check for collisions
      const finalContainerPositions = new Map()
      containerPositionsFromLayout.forEach((pos, containerId) => {
        const size = containerSizes.get(containerId)
        if (size) {
          // Apply offset (positions are already top-left)
          let finalPos = {
            x: pos.x + offset.x,
            y: pos.y + offset.y
          }

          // Check for collisions with individual nodes and adjust
          const collision = this.checkCollision(
            finalPos.x,
            finalPos.y,
            size.width,
            size.height,
            containerId,
            offsetIndividualPositions,
            individualNodes
          )

          if (collision.collides && collision.adjustX) {
            finalPos.x = Math.max(finalPos.x, collision.adjustX)
          }

          finalContainerPositions.set(containerId, finalPos)
        }
      })

      // Step 4: Build flow nodes and edges
      const flowNodes = [...this.nodes]
      const flowEdges = [...this.edges]

      // Add individual nodes
      individualNodes.forEach(node => {
        const pos = offsetIndividualPositions.get(node.id)
        if (pos) {
          flowNodes.push({
            id: node.id,
            type: 'default',
            position: pos,
            width: node.width || NODE_WIDTH,
            height: node.height || NODE_HEIGHT,
            data: { label: node.id },
            draggable: true
          })
        }
      })

      // Add containers and their children
      for (const container of containersToAdd) {
        const containerPos = finalContainerPositions.get(container.id)
        const containerSize = containerSizes.get(container.id)
        const childrenPositions = containerChildrenPositions.get(container.id)

        if (containerPos && containerSize) {
          // Add container node
          flowNodes.push({
            id: container.id,
            type: 'default',
            position: containerPos,
            width: containerSize.width,
            height: containerSize.height,
            style: {
              width: `${containerSize.width}px`,
              height: `${containerSize.height}px`,
              border: '2px solid #6366f1',
              borderRadius: '8px',
              background: 'rgba(99, 102, 241, 0.1)'
            },
            data: { label: container.id },
            selectable: true,
            draggable: true
          })

          // Add container children
          if (childrenPositions) {
            container.childIds.forEach(childId => {
              const childPos = childrenPositions.get(childId)
              if (childPos) {
                flowNodes.push({
                  id: childId,
                  type: 'default',
                  position: { x: childPos.x, y: childPos.y },
                  data: { label: childId },
                  parentNode: container.id,
                  extent: 'parent',
                  draggable: true
                })
              }
            })
          }
        }
      }

      // Add edges (filter out edges between container children in same container)
      const addedEdgeIds = new Set(this.edges.map(e => e.id))
      prefixEdges.forEach(edge => {
        const edgeId = `edge-${edge.source}-${edge.target}`

        // Check if both nodes exist
        const sourceExists = flowNodes.some(n => n.id === edge.source)
        const targetExists = flowNodes.some(n => n.id === edge.target)

        if (!sourceExists || !targetExists) return

        // Filter edges between container children in same container
        const sourceNode = flowNodes.find(n => n.id === edge.source)
        const targetNode = flowNodes.find(n => n.id === edge.target)

        if (sourceNode?.parentNode && targetNode?.parentNode &&
            sourceNode.parentNode === targetNode.parentNode) {
          // Both are in same container - check if explicit edge exists
          const originalSource = edge.source.replace(prefix, '')
          const originalTarget = edge.target.replace(prefix, '')
          const hasExplicitEdge = newEdges.some(e =>
            e.source === originalSource && e.target === originalTarget
          )
          if (!hasExplicitEdge) {
            console.log(`Filtering edge ${edge.source}->${edge.target}: same container children`)
            return
          }
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

      // Log all edges
      console.log('=== ALL EDGES ===')
      flowEdges.forEach(edge => {
        console.log(`  ${edge.source} -> ${edge.target}`)
      })

      this.nodes = flowNodes
      this.edges = flowEdges
    },

    /**
     * Layout nodes using Dagre algorithm (positions calculated independently, starting from 0,0)
     */
    layoutWithDagre(nodes, edges, includeContainers = false) {
      if (nodes.length === 0) return new Map()

      const g = new dagre.graphlib.Graph()
      g.setDefaultEdgeLabel(() => ({}))
      g.setGraph({
        rankdir: 'TB',
        nodesep: this.NODE_GAP,
        ranksep: this.RANK_GAP
      })

      // Add nodes to Dagre
      nodes.forEach(node => {
        g.setNode(node.id, {
          width: node.width || NODE_WIDTH,
          height: node.height || NODE_HEIGHT
        })
      })

      // Add edges to Dagre
      edges.forEach(edge => {
        g.setEdge(edge.source, edge.target)
      })

      // Run layout
      dagre.layout(g)

      // Extract positions (independent, starting from 0,0)
      const positions = new Map()

      g.nodes().forEach(nodeId => {
        const node = g.node(nodeId)
        if (node.x !== undefined && node.y !== undefined) {
          const nodeData = nodes.find(n => n.id === nodeId)
          const width = nodeData?.width || NODE_WIDTH
          const height = nodeData?.height || NODE_HEIGHT

          // Positions are calculated independently (Dagre gives center coordinates)
          positions.set(nodeId, {
            x: node.x - width / 2,
            y: node.y - height / 2
          })
        }
      })

      return positions
    },

    /**
     * Layout container children using Dagre
     */
    layoutContainerChildrenWithDagre(childNodes, childEdges) {
      if (childNodes.length === 0) {
        return { positions: new Map(), size: { width: NODE_WIDTH, height: NODE_HEIGHT } }
      }

      const g = new dagre.graphlib.Graph()
      g.setDefaultEdgeLabel(() => ({}))
      g.setGraph({
        rankdir: 'TB',
        nodesep: this.CONTAINER_CHILD_GAP,
        ranksep: this.CONTAINER_CHILD_GAP
      })

      // Add nodes
      childNodes.forEach(node => {
        g.setNode(node.id, {
          width: node.width || NODE_WIDTH,
          height: node.height || NODE_HEIGHT
        })
      })

      // Add edges
      childEdges.forEach(edge => {
        g.setEdge(edge.source, edge.target)
      })

      // Run layout
      dagre.layout(g)

      // Extract positions
      const positions = new Map()
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity

      g.nodes().forEach(nodeId => {
        const node = g.node(nodeId)
        if (node.x !== undefined && node.y !== undefined) {
          const nodeData = childNodes.find(n => n.id === nodeId)
          const width = nodeData?.width || NODE_WIDTH
          const height = nodeData?.height || NODE_HEIGHT

          const x = node.x - width / 2
          const y = node.y - height / 2

          positions.set(nodeId, { x, y })

          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x + width)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y + height)
        }
      })

      // Calculate container size with padding
      const width = maxX - minX + (this.CONTAINER_PADDING * 2)
      const height = maxY - minY + (this.CONTAINER_PADDING * 2)

      // Adjust positions to account for padding
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
     * Calculate offset to place new graph in free space
     */
    calculateGraphOffset(individualPositions, containerPositions, containerSizes) {
      // Find bounds of new graph (before offset)
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity

      // Check individual nodes
      individualPositions.forEach((pos, nodeId) => {
        const width = NODE_WIDTH
        const height = NODE_HEIGHT
        minX = Math.min(minX, pos.x)
        minY = Math.min(minY, pos.y)
        maxX = Math.max(maxX, pos.x + width)
        maxY = Math.max(maxY, pos.y + height)
      })

      // Check containers (using actual sizes)
      containerPositions.forEach((pos, containerId) => {
        const size = containerSizes.get(containerId) || { width: NODE_WIDTH * 2, height: NODE_HEIGHT * 2 }
        // pos is center position from Dagre
        const leftX = pos.x - size.width / 2
        const topY = pos.y - size.height / 2
        minX = Math.min(minX, leftX)
        minY = Math.min(minY, topY)
        maxX = Math.max(maxX, leftX + size.width)
        maxY = Math.max(maxY, topY + size.height)
      })

      // Get bounds of existing nodes
      const existingMaxY = this.getMaxY()

      // Calculate offset: place new graph below existing nodes
      const offsetX = 0 // Keep X alignment
      const offsetY = existingMaxY > 0 ? existingMaxY + this.RANK_GAP - minY : (minY < 0 ? -minY : 0)

      return { x: offsetX, y: offsetY }
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
     * Get minimum X position of existing nodes
     */
    getMinX() {
      if (this.nodes.length === 0) return 0

      let minX = Infinity
      this.nodes.forEach(node => {
        if (!node.parentNode) {
          minX = Math.min(minX, node.position.x)
        }
      })
      return minX === Infinity ? 0 : minX
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
    },

    /**
     * Check for collisions between a position and existing nodes
     */
    checkCollision(x, y, width, height, excludeId, individualPositions, individualNodes) {
      const padding = 10
      let maxAdjustX = 0

      // Check against individual nodes
      individualPositions.forEach((pos, nodeId) => {
        if (nodeId === excludeId) return

        const node = individualNodes.find(n => n.id === nodeId)
        const nodeWidth = node?.width || NODE_WIDTH
        const nodeHeight = node?.height || NODE_HEIGHT

        // Check for overlap
        if (!(x + width + padding < pos.x ||
              x > pos.x + nodeWidth + padding ||
              y + height + padding < pos.y ||
              y > pos.y + nodeHeight + padding)) {
          const adjustX = pos.x + nodeWidth + this.NODE_GAP
          maxAdjustX = Math.max(maxAdjustX, adjustX)
        }
      })

      // Check against existing nodes on canvas
      this.nodes.forEach(node => {
        if (node.id === excludeId || node.parentNode) return

        const nodeWidth = node.width || (node.style?.width ? parseInt(node.style.width) : NODE_WIDTH)
        const nodeHeight = node.height || (node.style?.height ? parseInt(node.style.height) : NODE_HEIGHT)
        const nodePos = node.position

        // Check for overlap
        if (!(x + width + padding < nodePos.x ||
              x > nodePos.x + nodeWidth + padding ||
              y + height + padding < nodePos.y ||
              y > nodePos.y + nodeHeight + padding)) {
          const adjustX = nodePos.x + nodeWidth + this.NODE_GAP
          maxAdjustX = Math.max(maxAdjustX, adjustX)
        }
      })

      if (maxAdjustX > 0) {
        return { collides: true, adjustX: maxAdjustX }
      }
      return { collides: false }
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
