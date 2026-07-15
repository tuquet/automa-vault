const fs = require('fs');
const path = require('path');

// Dynamically require dagre from the frontend monorepo
let dagre;
try {
  dagre = require('../automa-ex/node_modules/dagre');
} catch (e) {
  console.error('[Auto-Align] Could not load dagre from automa frontend. Please run `pnpm i` in the frontend.');
  process.exit(1);
}

const args = process.argv.slice(2);
const projectArg = args.find(arg => arg.startsWith('--project='));
const projectName = projectArg ? projectArg.split('=')[1] : 'crm';

const WORKFLOWS_DIR = path.join(__dirname, projectName, 'workflows');

function cleanOrphanedNodes(drawflow) {
  if (!drawflow || !drawflow.nodes || !drawflow.edges) return false;

  const connectedNodeIds = new Set();
  drawflow.edges.forEach(edge => {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  });

  const originalCount = drawflow.nodes.length;
  // Keep node if it's connected, or if it's a special type that doesn't need edges (like note/trigger)
  drawflow.nodes = drawflow.nodes.filter(node => {
    if (connectedNodeIds.has(node.id)) return true;
    if (node.label === 'trigger' || node.label === 'note' || node.label === 'blocks-group-2') return true;
    // Special event nodes that can act as triggers without incoming edges
    if (['event-click', 'webhook', 'schedule'].includes(node.label)) return true;
    
    // Otherwise, it's an orphaned 0-edge node and should be removed
    return false;
  });

  return drawflow.nodes.length !== originalCount;
}

function alignDrawflow(drawflow) {
  if (!drawflow || !drawflow.nodes || !drawflow.edges) return false;

  let hasChanges = cleanOrphanedNodes(drawflow);

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 100,
    ranker: 'tight-tree',
  });
  graph._isMultigraph = true;
  graph.setDefaultEdgeLabel(() => ({}));

  // Add Nodes
  drawflow.nodes.forEach(node => {
    // Skip groups just like the frontend
    if (node.label === 'blocks-group-2' || node.parentNode) return;

    graph.setNode(node.id, {
      label: node.label,
      width: 280, // Slightly wider
      height: 180, // Taller to account for description and conditions
    });
  });

  // Add Edges
  drawflow.edges.forEach(edge => {
    graph.setEdge(edge.source, edge.target, { id: edge.id });
  });

  // Calculate layout
  dagre.layout(graph);

  // Apply positions back to drawflow
  drawflow.nodes.forEach(node => {
    const graphNode = graph.node(node.id);
    if (!graphNode) return;

    const newX = Math.round(graphNode.x);
    const newY = Math.round(graphNode.y);

    if (node.position) {
      const oldX = Math.round(node.position.x);
      const oldY = Math.round(node.position.y);
      if (oldX !== newX || oldY !== newY) {
        node.position.x = newX;
        node.position.y = newY;
        hasChanges = true;
      }
    } else {
      node.position = { x: newX, y: newY };
      hasChanges = true;
    }
  });

  return hasChanges;
}

function run() {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    console.log('[Auto-Align] No workflows directory found, skipping.');
    return;
  }

  const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
  let alignedCount = 0;

  for (const file of files) {
    const filePath = path.join(WORKFLOWS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      let parsedDrawflow = null;
      let isStringified = false;

      // Handle both stringified drawflow and object drawflow
      if (typeof data.drawflow === 'string') {
        parsedDrawflow = JSON.parse(data.drawflow);
        isStringified = true;
      } else if (typeof data.drawflow === 'object') {
        parsedDrawflow = data.drawflow;
      }

      if (parsedDrawflow) {
        const didChange = alignDrawflow(parsedDrawflow);
        if (didChange) {
          if (isStringified) {
            data.drawflow = JSON.stringify(parsedDrawflow);
          } else {
            data.drawflow = parsedDrawflow;
          }
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          alignedCount++;
        }
      }
    } catch (e) {
      console.error(`[Auto-Align] Failed to process ${file}:`, e.message);
    }
  }

  if (alignedCount > 0) {
    console.log(`[Auto-Align] Successfully aligned ${alignedCount} workflows.`);
  }
}

run();
