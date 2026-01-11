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

<script setup>
import { ref, onMounted } from 'vue'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import dagre from 'dagre'
import { NODE_WIDTH, NODE_HEIGHT, initialGraphData } from './data'

const nodes = ref([])
const edges = ref([])

// Layout constants
const RANK_GAP = 80  // Vertical gap between ranks (rows) - reduced for tighter spacing
const NODE_GAP = 50   // Horizontal gap between nodes in same rank (row)
const CONTAINER_PADDING = 20
const CONTAINER_CHILD_GAP = 50  // Horizontal gap between children in container

// Layout state - tracks node ordering
const nodeOrdering = new Map() // nodeId -> { rank, order }

// PHASE 1: Use Dagre for ordering only (not positions)
function computeOrdering(allNodes, allEdges, containers) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 1, ranksep: 1 })

  // Add all main nodes (not container children) to Dagre with dummy sizes
  const mainNodeIds = new Set()
  allNodes.forEach(node => {
    if (!containers.some(c => c.childIds.includes(node.id))) {
      mainNodeIds.add(node.id)
      g.setNode(node.id, { width: 1, height: 1 })
    }
  })

  // Add containers as nodes
  containers.forEach(container => {
    g.setNode(container.id, { width: 1, height: 1 })
  })

  // Map container children to their containers
  const childToContainer = new Map()
  containers.forEach(container => {
    container.childIds.forEach(childId => {
      childToContainer.set(childId, container.id)
    })
  })

  // Add edges (map container children to their containers)
  const dagreEdges = []
  allEdges.forEach(edge => {
    let source = edge.source
    let target = edge.target

    // If source is a container child, use the container
    if (childToContainer.has(source)) {
      source = childToContainer.get(source)
    }

    // If target is a container child, use the container
    if (childToContainer.has(target)) {
      target = childToContainer.get(target)
    }

    // Only add edges between main nodes/containers
    const sourceIsMain = mainNodeIds.has(source) || containers.some(c => c.id === source)
    const targetIsMain = mainNodeIds.has(target) || containers.some(c => c.id === target)

    if (sourceIsMain && targetIsMain && source !== target) {
      g.setEdge(source, target)
      dagreEdges.push(`${source} -> ${target}`)
    }
  })

  console.log('Dagre Edges:', dagreEdges)
  dagre.layout(g)

  // Extract ordering (rank and order within rank)
  // Dagre doesn't always set 'rank' on nodes, so we'll compute it from y coordinates
  // or use BFS to determine ranks based on graph structure
  const ordering = new Map()
  const rankMap = new Map() // rank -> [nodeIds in order]

  // Compute ranks using BFS (more reliable than Dagre's rank property)
  // Handle disconnected components by running BFS on each component separately
  const ranks = new Map()
  const visited = new Set()
  const allNodeIds = g.nodes()

  // Function to run BFS starting from a root node
  const bfsFromRoot = (rootId, startRank) => {
    const queue = [{ id: rootId, rank: startRank }]
    visited.add(rootId)
    ranks.set(rootId, startRank)

    let head = 0
    while (head < queue.length) {
      const { id: nodeId, rank } = queue[head++]

      // Process outgoing edges
      g.outEdges(nodeId)?.forEach(edge => {
        const targetId = edge.w
        if (!visited.has(targetId)) {
          visited.add(targetId)
          const targetRank = rank + 1
          ranks.set(targetId, targetRank)
          queue.push({ id: targetId, rank: targetRank })
        }
      })
    }
  }

  // Find root nodes (nodes with no incoming edges) for each connected component
  const hasIncoming = new Set()
  g.edges().forEach(edge => {
    hasIncoming.add(edge.w)
  })

  // Process each connected component
  allNodeIds.forEach(nodeId => {
    if (!visited.has(nodeId) && !hasIncoming.has(nodeId)) {
      // This is a root of a new component - start BFS from here
      bfsFromRoot(nodeId, 0)
    }
  })

  // Handle any remaining unvisited nodes (isolated nodes or nodes in cycles)
  allNodeIds.forEach(nodeId => {
    if (!visited.has(nodeId)) {
      // For isolated nodes, assign rank 0
      ranks.set(nodeId, 0)
      visited.add(nodeId)
    }
  })

  // Group nodes by rank and get order from Dagre
  g.nodes().forEach(nodeId => {
    const node = g.node(nodeId)
    const rank = ranks.get(nodeId) ?? 0
    const order = node.order ?? 0

    if (!rankMap.has(rank)) {
      rankMap.set(rank, [])
    }
    rankMap.get(rank).push({ id: nodeId, order })
    ordering.set(nodeId, { rank, order })
  })

  // Sort nodes within each rank by order
  rankMap.forEach((nodes, rank) => {
    nodes.sort((a, b) => a.order - b.order)
  })

  // Debug: log ranks
  console.log('Dagre Ranks:', Array.from(rankMap.entries()).map(([rank, nodes]) => ({
    rank,
    nodes: nodes.map(n => n.id)
  })))

  return { ordering, rankMap }
}

// PHASE 2: Container-aware box layout (children vertically to show hierarchy)
function layoutContainerChildren(container, childNodes, childEdges) {
  // Place children vertically (top to bottom) to show hierarchy
  const childPositions = new Map()
  let currentY = CONTAINER_PADDING
  let maxWidth = 0

  // Sort children by their order in edges to maintain hierarchy
  const sortedChildren = [...childNodes]
  if (childEdges.length > 0) {
    // Build a proper ordering based on edge flow
    const childOrder = new Map()
    const visited = new Set()

    // Find root nodes (no incoming edges)
    const rootNodes = childNodes.filter(child =>
      !childEdges.some(e => e.target === child.id)
    )

    // BFS traversal to determine order
    const queue = [...rootNodes]
    let order = 0

    while (queue.length > 0) {
      const current = queue.shift()
      if (visited.has(current.id)) continue

      visited.add(current.id)
      childOrder.set(current.id, order++)

      // Add children of current node
      childEdges
        .filter(e => e.source === current.id)
        .forEach(e => {
          if (!visited.has(e.target)) {
            queue.push(childNodes.find(n => n.id === e.target))
          }
        })
    }

    // Sort by order
    sortedChildren.sort((a, b) => {
      const orderA = childOrder.get(a.id) ?? 999
      const orderB = childOrder.get(b.id) ?? 999
      return orderA - orderB
    })
  }

  sortedChildren.forEach((child) => {
    const childWidth = child.width || NODE_WIDTH
    const childHeight = child.height || NODE_HEIGHT

    childPositions.set(child.id, {
      x: CONTAINER_PADDING,
      y: currentY,
      width: childWidth,
      height: childHeight,
    })

    maxWidth = Math.max(maxWidth, childWidth)
    currentY += childHeight + CONTAINER_CHILD_GAP
  })

  const containerWidth = maxWidth + (CONTAINER_PADDING * 2)
  const containerHeight = currentY - CONTAINER_CHILD_GAP + CONTAINER_PADDING

  return { childPositions, size: { width: containerWidth, height: containerHeight } }
}

// PHASE 2: Layout nodes in ranks (same rank = row, deeper ranks = below)
function layoutRanks(ordering, rankMap, allNodes, containers, existingNodes, allEdges) {
  const nodePositions = new Map()
  const containerData = new Map()

  // Track existing node positions
  const existingPositions = new Map()
  const isExisting = new Set()
  existingNodes.forEach(node => {
    if (!node.parentNode) {
      existingPositions.set(node.id, node.position)
      isExisting.add(node.id)
    }
  })

  // Find max Y from existing nodes to determine starting Y for new ranks
  let maxExistingY = 0
  if (existingNodes.length > 0) {
    const existingYs = Array.from(existingPositions.entries()).map(([nodeId, position]) => {
      const node = existingNodes.find(n => n.id === nodeId)
      const height = node?.height || (node?.style?.height ? parseInt(node.style.height) : null) || NODE_HEIGHT
      return position.y + height
    })
    maxExistingY = Math.max(...existingYs, 0)
  }

  // Process each rank (ranks are stacked vertically, rank 0 at top)
  const ranks = Array.from(rankMap.keys()).sort((a, b) => a - b)
  let currentRankY = 0 // Y position for current rank (starts at top for rank 0)

  // Debug: log rank positions
  console.log('Layout Ranks:', ranks)

  ranks.forEach(rank => {
    const nodesInRank = rankMap.get(rank)
    let currentX = 0 // X position for nodes in this rank (horizontal placement)
    let maxHeightInRank = 0 // Track max height in this rank

    // Find rightmost X of existing nodes in this rank (for incremental placement)
    if (existingNodes.length > 0) {
      nodesInRank.forEach(({ id: nodeId }) => {
        if (isExisting.has(nodeId)) {
          const existing = existingPositions.get(nodeId)
          if (existing) {
            const node = allNodes.find(n => n.id === nodeId)
            const container = containers.find(c => c.id === nodeId)
            let width = NODE_WIDTH
            if (container) {
              // We'll calculate this in first pass, but for now use a placeholder
            } else if (node) {
              width = node.width || NODE_WIDTH
            }
            const rightX = existing.x + width
            if (rightX > currentX) {
              currentX = rightX + NODE_GAP
            }
          }
        }
      })
    }

    // First pass: calculate container sizes and find max height
    nodesInRank.forEach(({ id: nodeId }) => {
      const container = containers.find(c => c.id === nodeId)
      if (container) {
        const childNodes = allNodes.filter(n => container.childIds.includes(n.id))
        const childEdges = allEdges.filter(e =>
          container.childIds.includes(e.source) && container.childIds.includes(e.target)
        )
        const containerLayout = layoutContainerChildren(container, childNodes, childEdges)
        containerData.set(container.id, containerLayout)
        maxHeightInRank = Math.max(maxHeightInRank, containerLayout.size.height)

        // Update currentX if this is an existing container
        if (isExisting.has(container.id)) {
          const existing = existingPositions.get(container.id)
          if (existing) {
            const rightX = existing.x + containerLayout.size.width
            if (rightX > currentX) {
              currentX = rightX + NODE_GAP
            }
          }
        }
      } else {
        const node = allNodes.find(n => n.id === nodeId)
        if (node) {
          maxHeightInRank = Math.max(maxHeightInRank, node.height || NODE_HEIGHT)
        }
      }
    })

    // Second pass: place nodes horizontally in this rank
    nodesInRank.forEach(({ id: nodeId }) => {
      const container = containers.find(c => c.id === nodeId)

      if (container) {
        const containerLayout = containerData.get(container.id)

        if (isExisting.has(container.id)) {
          // Preserve existing position (only for incremental additions)
          const existing = existingPositions.get(container.id)
          nodePositions.set(container.id, existing)
        } else {
          // New container - place horizontally in rank
          const x = currentX
          const y = currentRankY
          nodePositions.set(container.id, { x, y })
          console.log(`Placed container ${container.id} at rank ${rank}, position (${x}, ${y})`)
          currentX += containerLayout.size.width + NODE_GAP
        }
      } else {
        // Regular node
        const node = allNodes.find(n => n.id === nodeId)
        if (node) {
          if (isExisting.has(nodeId) && existingNodes.length > 0) {
            // Preserve existing position (only for incremental additions)
            const existing = existingPositions.get(nodeId)
            nodePositions.set(nodeId, existing)
          } else {
            // New node - place horizontally in rank
            const nodeWidth = node.width || NODE_WIDTH
            const x = currentX
            const y = currentRankY
            nodePositions.set(nodeId, { x, y })
            console.log(`Placed node ${nodeId} at rank ${rank}, position (${x}, ${y})`)
            currentX += nodeWidth + NODE_GAP
          }
        }
      }
    })

    // Move to next rank (below current rank)
    currentRankY += maxHeightInRank + RANK_GAP
  })

  return { nodePositions, containerData }
}

// Global counter for auto-generating unique prefixes
let graphInstanceCounter = 0

// PHASE 3: Incremental insertion
async function addToGraph({ nodes: newNodes = [], edges: newEdges = [], containers: newContainers = [] }, prefix = null) {
  // Generate prefix if not provided
  if (prefix === null) {
    prefix = `graph_${graphInstanceCounter++}_`
  }

  // Apply prefix to all IDs
  const prefixNodes = newNodes.map(node => ({
    ...node,
    id: `${prefix}${node.id}`
  }))

  const prefixEdges = newEdges.map(edge => ({
    ...edge,
    source: `${prefix}${edge.source}`,
    target: `${prefix}${edge.target}`
  }))

  const prefixContainers = newContainers.map(container => ({
    ...container,
    id: `${prefix}${container.id}`,
    childIds: container.childIds.map(childId => `${prefix}${childId}`)
  }))

  // Get existing data
  const existingNodeIds = new Set(nodes.value.map(n => n.id))
  const existingContainerIds = new Set(
    nodes.value.filter(n => n.style?.border).map(n => n.id)
  )

  // Filter new items (now using prefixed IDs)
  const nodesToAdd = prefixNodes.filter(n => !existingNodeIds.has(n.id))
  const containersToAdd = prefixContainers.filter(c => !existingContainerIds.has(c.id))

  console.log('addToGraph called:', {
    prefix,
    newNodes: newNodes.length,
    nodesToAdd: nodesToAdd.length,
    newContainers: newContainers.length,
    containersToAdd: containersToAdd.length,
    existingNodes: nodes.value.length
  })

  // Build complete lists
  const allNodes = [
    ...nodes.value.filter(n => !n.parentNode).map(n => ({
      id: n.id,
      width: n.width || NODE_WIDTH,
      height: n.height || NODE_HEIGHT,
    })),
    ...nodesToAdd,
  ]

  const allContainers = [
    ...nodes.value
      .filter(n => n.style?.border)
      .map(n => {
        const childIds = nodes.value
          .filter(child => child.parentNode === n.id)
          .map(child => child.id)
        return { id: n.id, childIds }
      }),
    ...containersToAdd,
  ]

  const allEdges = [...edges.value, ...prefixEdges]

  // PHASE 1: Compute ordering with Dagre
  const { ordering, rankMap } = computeOrdering(allNodes, allEdges, allContainers)

  console.log('After computeOrdering:', {
    allNodesCount: allNodes.length,
    rankMapSize: rankMap.size,
    rankMapEntries: Array.from(rankMap.entries()).map(([rank, nodes]) => ({
      rank,
      nodeIds: nodes.map(n => n.id)
    }))
  })

  // PHASE 2: Layout with container awareness
  const { nodePositions, containerData } = layoutRanks(
    ordering,
    rankMap,
    allNodes,
    allContainers,
    nodes.value,
    allEdges
  )

  console.log('After layoutRanks:', {
    nodePositionsSize: nodePositions.size,
    nodePositions: Array.from(nodePositions.entries()).map(([id, pos]) => ({ id, pos }))
  })

  // Start with existing nodes and edges (keep them as-is)
  const flowNodes = [...nodes.value]
  const flowEdges = [...edges.value]

  // Track which nodes we've already added to avoid duplicates
  const addedNodeIds = new Set(flowNodes.map(n => n.id))
  const addedEdgeIds = new Set(flowEdges.map(e => e.id))

  // Track container IDs to identify them
  const containerIds = new Set(allContainers.map(c => c.id))

  // Add only NEW regular nodes (not containers, not container children)
  nodesToAdd.forEach(node => {
    const pos = nodePositions.get(node.id)
    const isContainerChild = allContainers.some(c => c.childIds.includes(node.id))
    const isContainer = containerIds.has(node.id)

    if (pos && !isContainerChild && !isContainer && !addedNodeIds.has(node.id)) {
      flowNodes.push({
        id: node.id,
        type: 'default',
        position: pos,
        width: node.width || NODE_WIDTH,
        height: node.height || NODE_HEIGHT,
        data: { label: node.id },
        draggable: true,
      })
      addedNodeIds.add(node.id)
    }
  })

  // Add only NEW containers and their children
  containersToAdd.forEach(container => {
    const pos = nodePositions.get(container.id)
    const layout = containerData.get(container.id)

    if (pos && layout && !addedNodeIds.has(container.id)) {
      // Container node
      flowNodes.push({
        id: container.id,
        type: 'default',
        position: pos,
        width: layout.size.width,
        height: layout.size.height,
        style: {
          width: `${layout.size.width}px`,
          height: `${layout.size.height}px`,
          border: '2px solid #6366f1',
          borderRadius: '8px',
          background: 'rgba(99, 102, 241, 0.1)',
        },
        data: { label: container.id },
        selectable: true,
        draggable: true,
      })
      addedNodeIds.add(container.id)

      // Container children
      container.childIds.forEach(childId => {
        const childPos = layout.childPositions.get(childId)
        if (childPos && !addedNodeIds.has(childId)) {
          flowNodes.push({
            id: childId,
            type: 'default',
            position: { x: childPos.x, y: childPos.y },
            data: { label: childId },
            parentNode: container.id,
            extent: 'parent',
            draggable: false,
          })
          addedNodeIds.add(childId)
        }
      })
    }
  })

  // Add only NEW edges
  prefixEdges.forEach((edge, idx) => {
    const edgeId = `edge-${edge.source}-${edge.target}`
    if (!addedEdgeIds.has(edgeId)) {
      flowEdges.push({
        id: edgeId,
        source: edge.source,
        target: edge.target,
        type: 'bezier',
        animated: false,
      })
      addedEdgeIds.add(edgeId)
    }
  })

  console.log('Final flowNodes:', flowNodes.length, 'flowEdges:', flowEdges.length)
  console.log('Flow node IDs:', flowNodes.map(n => n.id))

  nodes.value = flowNodes
  edges.value = flowEdges
}

// Start with simple graph
onMounted(async () => {
  await addToGraph(initialGraphData)
})
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
