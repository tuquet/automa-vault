const fs = require('fs');
const path = require('path');

const sharedJsPath = path.join(__dirname, '..', 'automa-ex', 'src', 'utils', 'shared.js');
const destPath = path.join(__dirname, 'automa-tasks.json');

if (fs.existsSync(sharedJsPath)) {
  let code = fs.readFileSync(sharedJsPath, 'utf8');
  code = code.replace(/export const /g, 'exports.');
  
  const tempPath = path.join(__dirname, 'temp_shared.js');
  fs.writeFileSync(tempPath, code);
  
  const { tasks } = require('./temp_shared.js');
  
  fs.writeFileSync(destPath, JSON.stringify(tasks, null, 2));
  fs.unlinkSync(tempPath);
  
  console.log(`Successfully synced automa-tasks.json from shared.js (${Object.keys(tasks).length} labels)`);
} else {
  console.log(`shared.js not found at ${sharedJsPath}, skipping sync.`);
}
