const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const projectArg = args.find(arg => arg.startsWith('--project='));
const projectName = projectArg ? projectArg.split('=')[1] : 'crm';

const WORKFLOWS_DIR = path.join(__dirname, projectName, 'workflows');
const PACKAGES_DIR = path.join(__dirname, projectName, 'packages');
const VARIABLES_DIR = path.join(__dirname, projectName, 'variables');
const VREMIXICON_PATH = path.join(__dirname, '..', 'automa-ex', 'src', 'lib', 'vRemixicon.js');
const AUTOMA_TASKS_PATH = path.join(__dirname, 'automa-tasks.json');
try {
  const syncScript = path.join(__dirname, 'sync-automa-tasks.js');
  if (fs.existsSync(syncScript)) {
    require('child_process').execSync(`node "${syncScript}"`, { stdio: 'inherit' });
  }
} catch (e) {
  console.warn(`[WARN] Failed to run sync-automa-tasks.js`);
}

let automaTasks = {};
try {
  automaTasks = JSON.parse(fs.readFileSync(AUTOMA_TASKS_PATH, 'utf8'));
} catch (e) {
  console.warn(`[WARN] Could not load automa-tasks.json. Schema validation will be skipped.`);
}

let hasError = false;

const validIcons = new Set();
if (fs.existsSync(VREMIXICON_PATH)) {
  const content = fs.readFileSync(VREMIXICON_PATH, 'utf8');
  const iconsBlockMatch = content.match(/export const icons = \{([\s\S]*?)\};/);
  if (iconsBlockMatch) {
    const block = iconsBlockMatch[1];
    const lines = block.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([a-zA-Z0-9_]+)(?:,|\s*:)/);
      if (match) {
        validIcons.add(match[1]);
      }
    }
  }
}

const globalVariables = new Set();
if (fs.existsSync(VARIABLES_DIR)) {
  const files = fs.readdirSync(VARIABLES_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(VARIABLES_DIR, file), 'utf8'));
      if (v.name) {
        globalVariables.add(v.name);
        globalVariables.add('$$' + v.name);
      }
    } catch (e) {}
  }
}

function validateNodeSchema(nodeData, expectedData, filePath, nodeId, label) {
  if (!expectedData || typeof expectedData !== 'object' || Array.isArray(expectedData)) return;
  if (!nodeData || typeof nodeData !== 'object' || Array.isArray(nodeData)) return;

  for (const key in expectedData) {
    if (!(key in nodeData)) {
      console.error(`[ERROR] [${path.basename(filePath)}] Node '${nodeId}' (${label}) is missing required property: 'data.${key}'. The correct schema requires this property.`);
      hasError = true;
    } else {
      const expectedType = Array.isArray(expectedData[key]) ? 'array' : typeof expectedData[key];
      const actualType = Array.isArray(nodeData[key]) ? 'array' : typeof nodeData[key];
      
      // Strict type check for arrays and objects (ignore primitives because user can put empty strings, numbers, etc.)
      if (expectedType === 'array' && actualType !== 'array') {
        console.error(`[ERROR] [${path.basename(filePath)}] Node '${nodeId}' (${label}) property 'data.${key}' must be an array, but got ${actualType}.`);
        hasError = true;
      } else if (expectedType === 'object' && expectedData[key] !== null && actualType !== 'object') {
        console.error(`[ERROR] [${path.basename(filePath)}] Node '${nodeId}' (${label}) property 'data.${key}' must be an object, but got ${actualType}.`);
        hasError = true;
      }
    }
  }

  for (const key in nodeData) {
    if (!(key in expectedData) && key !== 'parameters') { // allow 'parameters' injection on trigger
      // console.warn(`[WARN] [${path.basename(filePath)}] Node '${nodeId}' (${label}) has unknown/hallucinated property: 'data.${key}'.`);
    }
  }
}

function lintFile(filePath, type) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`[ERROR] Cannot read file: ${filePath}`);
    hasError = true;
    return;
  }

  if (content.includes('Ã')) {
    console.error(`[ERROR] Mojibake (Encoding Error) detected in: ${filePath}`);
    hasError = true;
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch (err) {
    console.error(`[ERROR] Invalid JSON format: ${filePath}`);
    hasError = true;
    return;
  }

  if (!data.description || data.description.trim() === '') {
    console.error(`[ERROR] [${path.basename(filePath)}] ${type} is missing a root 'description'.`);
    hasError = true;
  }

  if (!data.icon || data.icon.trim() === '') {
    console.error(`[ERROR] [${path.basename(filePath)}] Missing or empty 'icon' field.`);
    hasError = true;
  } else if (validIcons.size > 0 && !validIcons.has(data.icon)) {
    console.error(`[ERROR] [${path.basename(filePath)}] Invalid icon '${data.icon}'. It is not imported in automa/src/lib/vRemixicon.js.`);
    hasError = true;
  }

  let nodes, edges;
  if (type === 'Workflow') {
    if (!data.drawflow || !data.drawflow.nodes || !data.drawflow.edges) {
      console.warn(`[WARN] Missing drawflow/nodes/edges in: ${filePath}`);
      return;
    }
    nodes = data.drawflow.nodes;
    edges = data.drawflow.edges;
  } else if (type === 'Package') {
    if (!data.data || !data.data.nodes || !data.data.edges) {
      console.warn(`[WARN] Missing data/nodes/edges in: ${filePath}`);
      return;
    }
    nodes = data.data.nodes;
    edges = data.data.edges;
  }

  if (type === 'Workflow') {
    if (data.trigger && Array.isArray(data.trigger.parameters)) {
      const pNames = new Set();
      for (const p of data.trigger.parameters) {
        if (pNames.has(p.name)) {
          console.error(`[ERROR] [${path.basename(filePath)}] Duplicate parameter name '${p.name}' in trigger.parameters.`);
          hasError = true;
        }
        pNames.add(p.name);
      }
    }
    if (data.trigger) {
      const validTriggers = ['manual', 'interval', 'date', 'specific-day', 'visit-web', 'keyboard-shortcut', 'on-startup'];
      if (data.trigger.type && !validTriggers.includes(data.trigger.type)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Invalid trigger.type: '${data.trigger.type}'. Expected one of: ${validTriggers.join(', ')}`);
        hasError = true;
      }
      if (data.trigger.type === 'interval' && (!data.trigger.interval || data.trigger.interval <= 0)) {
        console.error(`[ERROR] [${path.basename(filePath)}] trigger.type is 'interval' but interval is invalid: ${data.trigger.interval}`);
        hasError = true;
      }
    }

    const triggerParams = (data.trigger?.parameters || []).map(p => p.name);
    const validLocals = new Set(triggerParams);
    
    const nodesStr = JSON.stringify(nodes);

    // Hỗ trợ quét các biến được set động bằng automaSetVariable trong JS Block
    const setRegex = /automaSetVariable\s*\(\s*['"]([^'"]+)['"]/g;
    let setMatch;
    while ((setMatch = setRegex.exec(nodesStr)) !== null) {
      validLocals.add(setMatch[1]);
    }

    const regex = /\{\{variables\.([a-zA-Z0-9_$$]+)\}\}/g;
    let match;
    while ((match = regex.exec(nodesStr)) !== null) {
      const varName = match[1];

      if (!validLocals.has(varName) && !globalVariables.has(varName)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Undeclared variable used: '{{variables.${varName}}}'. It is neither in trigger.parameters nor global variables.`);
        hasError = true;
      }
    }

    const refRegex = /automaRefData\s*\(\s*['"]variables['"]\s*,\s*['"]([^'"]+)['"]/g;
    let refMatch;
    while ((refMatch = refRegex.exec(nodesStr)) !== null) {
      const varName = refMatch[1];
      if (!validLocals.has(varName) && !globalVariables.has(varName)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Undeclared variable used in JS Block: automaRefData('variables', '${varName}'). It is neither in trigger.parameters nor global variables.`);
        hasError = true;
      }
    }
  }

  const nodeMap = new Map();
  let rootTriggerParams = null;
  if (type === 'Workflow') {
    rootTriggerParams = data.trigger?.parameters || [];
  }

  for (const node of nodes) {
    if (automaTasks[node.label] && automaTasks[node.label].data) {
      validateNodeSchema(node.data, automaTasks[node.label].data, filePath, node.id, node.label);
    }

    if (type === 'Workflow' && node.label === 'trigger') {
      const nodeParams = node.data?.parameters || [];
      const nodeParamsStr = JSON.stringify(nodeParams);
      const rootParamsStr = JSON.stringify(rootTriggerParams);
      if (nodeParamsStr !== rootParamsStr) {
        console.error(`[ERROR] [${path.basename(filePath)}] The Trigger Node (id: '${node.id}') must have 'data.parameters' perfectly synchronized with the workflow's root 'trigger.parameters'. Automa UI requires this to render the input form. Please copy 'trigger.parameters' into the Trigger node's 'data.parameters'.`);
        hasError = true;
      }
    }

    if (nodeMap.has(node.id)) {
      console.error(`[ERROR] [${path.basename(filePath)}] Duplicate Node ID detected: '${node.id}' (${node.label}). This will break Vue Flow and Edge connections.`);
      hasError = true;
    }
    if (!node.data?.description || node.data.description.trim() === '') {
      console.error(`[ERROR] [${path.basename(filePath)}] Node '${node.id}' (${node.label}) is missing a 'description' in its data.`);
      hasError = true;
    }

    const validNodeTypes = ['BlockBasic', 'BlockConditions', 'BlockDelay', 'BlockPackage', 'BlockElementExists', 'BlockNote'];
    if (!validNodeTypes.includes(node.type)) {
      console.error(`[ERROR] [${path.basename(filePath)}] Node '${node.id}' (${node.label}) uses an invalid type '${node.type}'. Expected one of: ${validNodeTypes.join(', ')}`);
      hasError = true;
    }

    if (!node.position || typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
      console.error(`[ERROR] [${path.basename(filePath)}] Node '${node.id}' (${node.label}) is missing valid 'position' (x, y).`);
      hasError = true;
    }

    if (!node.data || typeof node.data !== 'object') {
      console.error(`[ERROR] [${path.basename(filePath)}] Node '${node.id}' (${node.label}) is missing a 'data' object.`);
      hasError = true;
    }

    if (node.type === 'BlockPackage') {
      if (!node.data?.data?.nodes || !node.data?.data?.edges) {
        console.error(`[ERROR] [${path.basename(filePath)}] BlockPackage '${node.id}' is missing embedded 'data.nodes' and 'data.edges'. Automa requires the target package data to be embedded here.`);
        hasError = true;
      }
      if (!node.data?.icon) {
        console.error(`[ERROR] [${path.basename(filePath)}] BlockPackage '${node.id}' is missing 'data.icon'. Vue Flow component will CRASH without it.`);
        hasError = true;
      }
      const inputs = node.data?.inputs || [];
      const outputs = node.data?.outputs || [];
      const checkInOut = (arr, typeName) => {
        for (const io of arr) {
          if (!io.id || typeof io.name !== 'string' || !io.blockId || !io.handleId) {
            console.error(`[ERROR] [${path.basename(filePath)}] BlockPackage '${node.id}' has malformed ${typeName}. Each must contain 'id', 'name', 'blockId', 'handleId'. Found: ${JSON.stringify(io)}`);
            hasError = true;
          }
        }
      };
      checkInOut(inputs, 'inputs');
      checkInOut(outputs, 'outputs');
    }

    nodeMap.set(node.id, node);
  }

  for (const edge of edges) {
    if (!edge.label || edge.label.trim() === '') {
      console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' is missing a 'label'.`);
      hasError = true;
    }

    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);

    if (!sourceNode) {
      console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' has unknown source node: '${edge.source}'`);
      hasError = true;
    }
    if (!targetNode) {
      console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' has unknown target node: '${edge.target}'`);
      hasError = true;
    }

    if (edge.id.startsWith('vueflow__edge-')) {
      const expectedId = `vueflow__edge-${edge.source}${edge.sourceHandle}-${edge.target}${edge.targetHandle}`;
      if (edge.id !== expectedId) {
        console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' has malformed ID. Expected: '${expectedId}'`);
        hasError = true;
      }
    }

    if (sourceNode && sourceNode.type === 'BlockPackage') {
      const outputs = sourceNode.data?.outputs || [];
      const validHandles = outputs.map(out => `${sourceNode.id}-output-${out.id}`);
      if (!validHandles.includes(edge.sourceHandle)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' uses invalid sourceHandle '${edge.sourceHandle}' for BlockPackage '${sourceNode.id}'. Expected one of: ${validHandles.join(', ')}`);
        hasError = true;
      }
    }

    if (sourceNode && sourceNode.label === 'conditions') {
      if (sourceNode.type !== 'BlockConditions') {
        console.error(`[ERROR] [${path.basename(filePath)}] Node '${sourceNode.id}' with label 'conditions' MUST have type 'BlockConditions', but got '${sourceNode.type}'`);
        hasError = true;
      }
      const conditionIds = (sourceNode.data?.conditions || []).map(c => c.id);
      const validHandles = [
        ...conditionIds.map(id => `${sourceNode.id}-output-${id}`),
        `${sourceNode.id}-output-fallback`
      ];
      if (!validHandles.includes(edge.sourceHandle)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' uses invalid sourceHandle '${edge.sourceHandle}' for Conditions block '${sourceNode.id}'. Expected one of: ${validHandles.join(', ')}`);
        hasError = true;
      }
    }

    if (targetNode && targetNode.type === 'BlockPackage') {
      const inputs = targetNode.data?.inputs || [];
      const validHandles = inputs.map(inp => `${targetNode.id}-input-${inp.id}`);
      if (!validHandles.includes(edge.targetHandle)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' uses invalid targetHandle '${edge.targetHandle}' for BlockPackage '${targetNode.id}'. Expected one of: ${validHandles.join(', ')}`);
        hasError = true;
      }
    }

    // Validate standard handles using automa-tasks.json
    if (sourceNode && automaTasks[sourceNode.label] && sourceNode.type !== 'BlockPackage' && sourceNode.type !== 'BlockConditions') {
      const task = automaTasks[sourceNode.label];
      const numOutputs = task.outputs || 0;
      const validHandles = [];
      for (let i = 1; i <= numOutputs; i++) {
        validHandles.push(`${sourceNode.id}-output-${i}`);
      }
      if (numOutputs > 0 && !validHandles.includes(edge.sourceHandle)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' uses invalid sourceHandle '${edge.sourceHandle}' for '${sourceNode.label}'. Expected one of: ${validHandles.join(', ')}`);
        hasError = true;
      }
    }

    if (targetNode && automaTasks[targetNode.label] && targetNode.type !== 'BlockPackage') {
      const task = automaTasks[targetNode.label];
      const numInputs = task.inputs || 0;
      const validHandles = [];
      for (let i = 1; i <= numInputs; i++) {
        validHandles.push(`${targetNode.id}-input-${i}`);
      }
      if (numInputs > 0 && !validHandles.includes(edge.targetHandle)) {
        console.error(`[ERROR] [${path.basename(filePath)}] Edge '${edge.id}' uses invalid targetHandle '${edge.targetHandle}' for '${targetNode.label}'. Expected one of: ${validHandles.join(', ')}`);
        hasError = true;
      }
    }
  }
}

function runLinter() {
  console.log('Starting Automa Linter (Workflows & Packages)...');
  
  if (fs.existsSync(WORKFLOWS_DIR)) {
    const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      lintFile(path.join(WORKFLOWS_DIR, file), 'Workflow');
    }
  }

  if (fs.existsSync(PACKAGES_DIR)) {
    const files = fs.readdirSync(PACKAGES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      lintFile(path.join(PACKAGES_DIR, file), 'Package');
    }
  }

  if (hasError) {
    console.error('Linting FAILED. Please fix the errors above.');
    process.exit(1);
  } else {
    console.log('Linting PASSED.');
  }
}

runLinter();
