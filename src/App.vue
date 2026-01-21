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
import { NODE_WIDTH, NODE_HEIGHT, initialGraphData, secondGraphData, thirdGraphData } from './data'

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
    this.addSubGraph(secondGraphData)
    this.addSubGraph(thirdGraphData)
  },
  methods: {
    /**
     * Add a sub graph to the canvas
     * @param {Object} graphData - { nodes: [], edges: [], containers: [] }
     */
    addSubGraph(graphData) {
      const prefix = `subgraph_${this.subGraphCounter++}_`
      const { nodes: newNodes = [], edges: newEdges = [], containers: newContainers = [] } = graphData

      // Keep individual node IDs unchanged (no prefix)
      const prefixNodes = newNodes.map(node => ({
        ...node,
        id: node.id // Keep original ID
      }))

      // Edges: keep original IDs (they may connect to existing nodes)
      const prefixEdges = newEdges.map(edge => ({
        source: edge.source, // Keep original ID (may be existing node)
        target: edge.target  // Keep original ID (may be existing node)
      }))

      // Containers: add prefix for unique IDs
      const prefixContainers = newContainers.map(container => ({
        id: `${prefix}${container.id}`, // Add prefix to container ID
        childIds: container.childIds.map(childId => childId) // Keep child IDs unchanged
      }))

      // Step 1: Find individual nodes (not in containers)
      const individualNodes = prefixNodes.filter(node => {
        return !prefixContainers.some(container => container.childIds.includes(node.id))
      })

      // Step 1.5: Separate new nodes from existing nodes
      // Store original existing node IDs (before adding new nodes)
      const originalExistingNodeIds = new Set(this.nodes.map(n => n.id))
      const existingNodeIds = new Set(this.nodes.map(n => n.id)) // This will be modified as we add nodes
      const newIndividualNodes = individualNodes.filter(node => !originalExistingNodeIds.has(node.id))
      const existingIndividualNodes = individualNodes.filter(node => originalExistingNodeIds.has(node.id))

      // Step 1.6: Find edges from existing nodes to new nodes and create temp root nodes
      const tempRootNodes = new Map() // Map: originalSourceId -> tempRootNode
      const modifiedEdges = [...prefixEdges]

      // Find all unique source nodes that connect to new nodes
      const sourceNodesToNewNodes = new Set()
      prefixEdges.forEach(edge => {
        const sourceIsExisting = originalExistingNodeIds.has(edge.source)
        const targetIsNew = !originalExistingNodeIds.has(edge.target)
        if (sourceIsExisting && targetIsNew) {
          sourceNodesToNewNodes.add(edge.source)
        }
      })

      // Create temp root nodes for each source
      sourceNodesToNewNodes.forEach(sourceId => {
        const tempRootId = `${prefix}temp_${sourceId}`
        const sourceNode = this.nodes.find(n => n.id === sourceId)
        if (sourceNode) {
          // Create temp root node as copy of source
          tempRootNodes.set(sourceId, {
            id: tempRootId,
            originalId: sourceId,
            data: { label: sourceNode.data?.label || sourceId },
            width: NODE_WIDTH,
            height: NODE_HEIGHT
          })

          // Replace edges: change source from original to temp root
          modifiedEdges.forEach(edge => {
            if (edge.source === sourceId && !originalExistingNodeIds.has(edge.target)) {
              edge.source = tempRootId
            }
          })
        }
      })

      // Add temp root nodes to the nodes list for layout
      const tempRootNodesList = Array.from(tempRootNodes.values())
      const allNodesForLayout = [...newIndividualNodes, ...tempRootNodesList]

      // Step 2: Find root node (temp root nodes or node with no incoming edges)
      // Temp root nodes are the roots of the new subgraph
      let rootNode = null

      if (tempRootNodesList.length > 0) {
        // Use first temp root as the root node
        rootNode = tempRootNodesList[0]
      } else {
        // Fallback: find root in new nodes
        rootNode = allNodesForLayout.find(node => {
          return !modifiedEdges.some(edge => edge.target === node.id)
        })
      }

      if (!rootNode && allNodesForLayout.length > 0) {
        // Use first new node as root if no root found
        rootNode = allNodesForLayout[0]
      }

      if (!rootNode) {
        console.error('No root node found')
        return
      }

      // Step 3: Layout new nodes (including temp root nodes) using Dagre
      const individualEdges = modifiedEdges.filter(edge => {
        const sourceIsInLayout = allNodesForLayout.some(n => n.id === edge.source)
        const targetIsInLayout = allNodesForLayout.some(n => n.id === edge.target)
        return sourceIsInLayout && targetIsInLayout
      })

      // Layout all new nodes including temp root nodes
      const individualPositions = allNodesForLayout.length > 0
        ? this.layoutNodesWithDagre(allNodesForLayout, individualEdges)
        : new Map()

      // Add existing node positions to the map (for container positioning)
      existingIndividualNodes.forEach(node => {
        const existingNode = this.nodes.find(n => n.id === node.id)
        if (existingNode) {
          individualPositions.set(node.id, {
            x: existingNode.position.x,
            y: existingNode.position.y
          })
        }
      })

      // Step 4: Layout failure container children (only new children need layout)
      const failureContainer = prefixContainers.find(c => c.id.includes('failure'))
      const failureLayout = failureContainer
        ? this.layoutContainerChildren(failureContainer, prefixNodes, prefixEdges, existingNodeIds)
        : null

      // Step 5: Layout success container children (only new children need layout)
      const successContainer = prefixContainers.find(c => c.id.includes('success'))
      const successLayout = successContainer
        ? this.layoutContainerChildren(successContainer, prefixNodes, prefixEdges, existingNodeIds)
        : null

      // Step 6: Calculate offset to place sub graph in free space
      const offset = this.calculateSubGraphOffset(individualPositions)

      // Step 7: Position failure container (left, first child level)
      const failureContainerPos = failureLayout
        ? this.positionFailureContainer(individualPositions, rootNode, failureLayout, offset)
        : null

      // Step 8: Position success container (right, first child level)
      const successContainerPos = successLayout
        ? this.positionSuccessContainer(individualPositions, rootNode, successLayout, offset, failureContainerPos, failureLayout)
        : null

      // Step 9: Build and add nodes to canvas
      const flowNodes = [...this.nodes]
      const flowEdges = [...this.edges]

      // Add temp root nodes first
      tempRootNodesList.forEach(tempRoot => {
        const pos = individualPositions.get(tempRoot.id)
        if (pos) {
          flowNodes.push({
            id: tempRoot.id,
            type: 'custom',
            position: {
              x: pos.x + offset.x,
              y: pos.y + offset.y
            },
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            data: { label: tempRoot.data.label },
            draggable: true,
            style: {
              border: '2px dashed #6366f1', // Dotted/dashed border for temp root
              borderRadius: '8px'
            }
          })
          existingNodeIds.add(tempRoot.id)
        }
      })

      // Add individual nodes with offset (only if they don't already exist)
      newIndividualNodes.forEach(node => {
        // Skip if node already exists
        if (existingNodeIds.has(node.id)) {
          return
        }

        const pos = individualPositions.get(node.id)
        if (pos) {
          flowNodes.push({
            id: node.id,
            type: 'custom',
            position: {
              x: pos.x + offset.x,
              y: pos.y + offset.y
            },
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            data: { label: node.id }, // Keep original ID as label
            draggable: true
          })
          existingNodeIds.add(node.id)
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
          // Skip if child already exists
          if (existingNodeIds.has(childId)) {
            return
          }

          const childPos = failureLayout.positions.get(childId)
          if (childPos) {
            flowNodes.push({
              id: childId,
              type: 'default',
              position: {
                x: childPos.x,  // Relative to container (0,0)
                y: childPos.y   // Relative to container (0,0)
              },
              data: { label: childId }, // Keep original ID as label
              parentNode: failureContainer.id,
              extent: 'parent',
              draggable: false
            })
            existingNodeIds.add(childId)
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
          // Skip if child already exists
          if (existingNodeIds.has(childId)) {
            return
          }

          const childPos = successLayout.positions.get(childId)
          if (childPos) {
            flowNodes.push({
              id: childId,
              type: 'default',
              position: {
                x: childPos.x,  // Relative to container (0,0)
                y: childPos.y   // Relative to container (0,0)
              },
              data: { label: childId }, // Keep original ID as label
              parentNode: successContainer.id,
              extent: 'parent',
              draggable: false
            })
            existingNodeIds.add(childId)
          }
        })
      }

      // Add edges connecting original source to temp root nodes
      tempRootNodes.forEach((tempRoot, originalSourceId) => {
        const edgeId = `edge-${originalSourceId}-${tempRoot.id}`
        const sourceExists = flowNodes.some(n => n.id === originalSourceId)
        const targetExists = flowNodes.some(n => n.id === tempRoot.id)

        if (sourceExists && targetExists) {
          // Update existing source node to use custom type with handles
          const sourceNodeIndex = flowNodes.findIndex(n => n.id === originalSourceId)
          if (sourceNodeIndex !== -1 && flowNodes[sourceNodeIndex].type !== 'custom') {
            flowNodes[sourceNodeIndex].type = 'custom'
          }

          flowEdges.push({
            id: edgeId,
            source: originalSourceId,
            target: tempRoot.id,
            type: 'default',
            animated: false,
            sourcePosition: 'right',
            targetPosition: 'left',
            style: {
              stroke: '#9ca3af', // Gray color for root-to-temp-root edge
              strokeWidth: 2,
              strokeDasharray: '5,5' // Dotted/dashed style
            }
          })
        }
      })

      // Add edges (filter out edges between container children in same container)
      const addedEdgeIds = new Set(this.edges.map(e => e.id))
      // Add temp root edges to addedEdgeIds
      tempRootNodes.forEach((tempRoot, originalSourceId) => {
        addedEdgeIds.add(`edge-${originalSourceId}-${tempRoot.id}`)
      })

      // Use modifiedEdges (which have temp root as source) instead of prefixEdges
      modifiedEdges.forEach(edge => {
        const edgeId = `edge-${edge.source}-${edge.target}`

        // Skip if edge already exists
        if (addedEdgeIds.has(edgeId)) {
          return
        }

        // Check if both nodes exist (may be existing nodes or new nodes)
        const sourceExists = flowNodes.some(n => n.id === edge.source)
        const targetExists = flowNodes.some(n => n.id === edge.target)

        if (!sourceExists || !targetExists) {
          console.warn(`Edge ${edge.source} -> ${edge.target} skipped: one or both nodes don't exist`)
          return
        }

        // Filter edges between container children in same container (unless explicit)
        const sourceNode = flowNodes.find(n => n.id === edge.source)
        const targetNode = flowNodes.find(n => n.id === edge.target)

        if (sourceNode?.parentNode && targetNode?.parentNode &&
            sourceNode.parentNode === targetNode.parentNode) {
          // Check if this edge is explicitly defined in the input
          const hasExplicitEdge = newEdges.some(e =>
            e.source === edge.source && e.target === edge.target
          )
          if (!hasExplicitEdge) return
        }

        const edgeConfig = {
          id: edgeId,
          source: edge.source,
          target: edge.target,
          type: 'default',
          animated: false
        }

        // If source is temp root, use right handle
        // If target is new node, use top handle
        const sourceIsTempRoot = tempRootNodesList.some(tr => tr.id === edge.source)
        const targetIsNew = !originalExistingNodeIds.has(edge.target)

        if (sourceIsTempRoot) {
          edgeConfig.sourcePosition = 'right'
        }
        if (targetIsNew) {
          edgeConfig.targetPosition = 'top'
        }

        flowEdges.push(edgeConfig)
        addedEdgeIds.add(edgeId)
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
    layoutContainerChildren(container, allNodes, allEdges, existingNodeIds = new Set()) {
      // Use all child nodes for edge filtering (to get all relevant edges)
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
    calculateSubGraphOffset(individualPositions) {
      if (!individualPositions || individualPositions.size === 0) {
        const existingMaxY = this.getMaxY()
        return { x: 0, y: existingMaxY > 0 ? existingMaxY + this.RANK_GAP : 0 }
      }

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
      const graphLeftX = this.getGraphLeftX(individualPositions)
      const failureX = graphLeftX - failureLayout.size.width - this.NODE_GAP

      return {
        x: failureX + offset.x,
        y: level1Y + offset.y
      }
    },

    /**
     * Position success container to the right, at first child level
     */
    positionSuccessContainer(individualPositions, rootNode, successLayout, offset, failureContainerPos, failureLayout) {
      const rootPos = individualPositions.get(rootNode.id)
      if (!rootPos) return null

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
    getGraphLeftX(individualPositions) {
      let minX = Infinity
      individualPositions.forEach(pos => {
        minX = Math.min(minX, pos.x)
      })
      return minX === Infinity ? 0 : minX
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

/* Style for temp root nodes (dotted border) */
.vue-flow__node[style*="dashed"] {
  border-style: dashed !important;
}
</style>
