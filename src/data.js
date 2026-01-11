export const NODE_WIDTH = 160
export const NODE_HEIGHT = 48

export const initialGraphData =
{
    nodes: [
      { id: 'A', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'B', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'C', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'D', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'E', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'F', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'G', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'H', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'I', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'J', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'K', width: NODE_WIDTH, height: NODE_HEIGHT },
      { id: 'L', width: NODE_WIDTH, height: NODE_HEIGHT },
    ],
    edges: [
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' },
      { source: 'C', target: 'D' },
      { source: 'D', target: 'E' },
      { source: 'A', target: 'F' },
      { source: 'F', target: 'G' },
      { source: 'G', target: 'H' },
      { source: 'H', target: 'L' },
      { source: 'A', target: 'I' },
      { source: 'I', target: 'J' },
      { source: 'J', target: 'K' },
    ],
    containers: [
      { id: 'success', childIds: ['C', 'D', 'E'] },
      { id: 'failure', childIds: ['F', 'G', 'H', 'L'] },
    ],
  }