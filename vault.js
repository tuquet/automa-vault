const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const action = args[0]; // push, pull, status, lint
const projectArg = args.find(arg => arg.startsWith('--project='));
const projectName = projectArg ? projectArg.split('=')[1] : 'crm';

if (!['push', 'pull', 'status', 'lint'].includes(action)) {
  console.error('Usage: npm run [push|pull|status|lint] -- --project=<projectName>');
  process.exit(1);
}

// Default local connection parameters
let SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
let ANON_KEY = process.env.ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
let enabledTables = ['workflows', 'packages', 'folders', 'variables', 'credentials', 'tables', 'table_rows'];

// Load project-specific vault configuration
const vaultSettingsPath = path.join(__dirname, projectName, '.vault', 'settings.json');
const localSettingsPath = path.join(__dirname, projectName, '.vault', 'settings.local.json');

function applySettings(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      const vaultSettings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (vaultSettings.supabaseUrl) SUPABASE_URL = vaultSettings.supabaseUrl;
      if (vaultSettings.supabaseAnonKey) ANON_KEY = vaultSettings.supabaseAnonKey;
      if (Array.isArray(vaultSettings.enabledTables)) enabledTables = vaultSettings.enabledTables;
    } catch (e) {
      console.warn(`[Vault Settings] Failed to parse ${path.basename(filePath)}:`, e.message);
    }
  }
}

applySettings(vaultSettingsPath);
applySettings(localSettingsPath);

if (action !== 'lint') {
  console.log(`[Vault Settings] Loaded configuration for project "${projectName}". Target DB: ${SUPABASE_URL}`);
}

// Structural comparison helper
function sortKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  return Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = sortKeys(obj[key]);
    return acc;
  }, {});
}

function isEqual(obj1, obj2) {
  const clean1 = JSON.parse(JSON.stringify(obj1 || {}));
  const clean2 = JSON.parse(JSON.stringify(obj2 || {}));
  
  const stripKeys = ['updatedAt', 'updated_at', 'client_updated_at', 'createdAt', 'created_at'];
  stripKeys.forEach(k => {
    delete clean1[k];
    delete clean2[k];
  });

  return JSON.stringify(sortKeys(clean1)) === JSON.stringify(sortKeys(clean2));
}

// Fetch helper
async function fetchTableData(tableName) {
  try {
    let url = `${SUPABASE_URL}/rest/v1/${tableName}`;
    if (tableName !== 'html_snapshots') {
      url += '?is_deleted=eq.false';
    }
    const res = await fetch(url, {
      headers: {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${ANON_KEY}`
      }
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error(`Failed to fetch ${tableName}:`, err.message);
    return [];
  }
}

// PUSH action logic
async function pushTable(tableName, folderName) {
  const folderPath = path.join(__dirname, projectName, folderName);
  if (!fs.existsSync(folderPath)) return;

  const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.json'));
  const existingDbRecords = await fetchTableData(tableName);
  
  const rows = [];
  let skipCount = 0;
  const processedIds = new Set();

  for (const file of files) {
    try {
      const filePath = path.join(folderPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const parsedData = JSON.parse(content);
      const dataItems = Array.isArray(parsedData) ? parsedData : [parsedData];

      let fileHasChanges = false;

      for (const item of dataItems) {
        let recordId = item.id || file.split('.')[0];
        if (tableName === 'variables') recordId = item.name || file.split('.')[0];
        processedIds.add(recordId);

        const dbRecord = existingDbRecords.find(r => {
          if (tableName === 'variables') return r.name === recordId;
          return r.id === recordId;
        }) || null;
        
        let isChanged = true;
        if (dbRecord) {
          const dbDataToCompare = (tableName === 'workflows' || tableName === 'packages') ? dbRecord.data : dbRecord;
          if (isEqual(item, dbDataToCompare)) {
            isChanged = false;
          }
        }

        if (!isChanged) {
          skipCount++;
          continue;
        }

        fileHasChanges = true;

        if (tableName === 'workflows' || tableName === 'packages') {
          item.updatedAt = Date.now();
        }

        let rowToInsert = {};
        if (tableName === 'workflows' || tableName === 'packages') {
          rowToInsert = {
            id: recordId,
            data: item,
          };
          if (tableName === 'packages') rowToInsert.is_shared = true;
        } else {
          rowToInsert = { ...item };
          if (tableName !== 'variables' && !rowToInsert.id) {
            rowToInsert.id = recordId;
          }
        }

        // Avoid invalid UUID types in DB
        if (tableName === 'html_snapshots' && rowToInsert.id) {
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(rowToInsert.id)) {
            delete rowToInsert.id;
          }
        }

        rowToInsert.is_deleted = false;
        rowToInsert.client_updated_at = new Date().toISOString();
        rows.push(rowToInsert);
      }

      if (fileHasChanges && (tableName === 'workflows' || tableName === 'packages')) {
        fs.writeFileSync(filePath, JSON.stringify(parsedData, null, 2), 'utf8');
      }
    } catch (err) {
      console.error(`Error processing ${file}:`, err);
    }
  }

  // Deletion tracking (Soft Delete on DB)
  let deletedCount = 0;
  if (tableName !== 'html_snapshots') {
    for (const dbRecord of existingDbRecords) {
      const recordId = tableName === 'variables' ? dbRecord.name : dbRecord.id;
      if (!processedIds.has(recordId) && !dbRecord.is_deleted) {
        const rowToDelete = { 
          ...dbRecord, 
          is_deleted: true, 
          client_updated_at: new Date().toISOString() 
        };
        
        delete rowToDelete.created_at;
        delete rowToDelete.updated_at;
        delete rowToDelete.createdAt;
        delete rowToDelete.updatedAt;

        rows.push(rowToDelete);
        deletedCount++;
      }
    }
  }

  if (rows.length === 0) {
    console.log(`[${tableName}] Skipped all ${skipCount} files (No changes).`);
    return;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}`, {
      method: 'POST',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(rows)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP error! status: ${res.status}, msg: ${errorText}`);
    }
    
    console.log(`[${tableName}] Seeded ${rows.length} records (${deletedCount} deleted). (Skipped ${skipCount} unchanged files).`);
  } catch (err) {
    console.error(`Failed to seed ${tableName}:`, err.message);
  }
}

// PULL action logic (Smart mapping to preserve readable names)
async function pullTable(tableName, folderName) {
  const folderPath = path.join(__dirname, projectName, folderName);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const existingDbRecords = await fetchTableData(tableName);
  const localFiles = fs.existsSync(folderPath) ? fs.readdirSync(folderPath).filter(f => f.endsWith('.json')) : [];
  
  // 1. Build an ID-to-fileName map by scanning existing local files
  const idToFileNameMap = new Map();
  for (const file of localFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(folderPath, file), 'utf8'));
      const items = Array.isArray(content) ? content : [content];
      for (const item of items) {
        let itemId = item.id;
        if (tableName === 'variables') itemId = item.name;
        if (itemId) {
          idToFileNameMap.set(itemId, file);
        }
      }
    } catch (e) {
      // Ignore parse errors for mapping
    }
  }

  const processedLocalFiles = new Set();
  
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const dbRecord of existingDbRecords) {
    const recordId = tableName === 'variables' ? dbRecord.name : dbRecord.id;
    
    // Determine the target file name
    let fileName = idToFileNameMap.get(recordId);
    if (!fileName) {
      // If it's a new record, construct a nice filename
      let baseName = recordId;
      const recordData = (tableName === 'workflows' || tableName === 'packages') ? dbRecord.data : dbRecord;
      if (recordData.name) {
        baseName = recordData.name;
      } else if (recordData.label) {
        baseName = recordData.label;
      } else if (recordData.nav_name) {
        baseName = recordData.nav_name;
      }
      
      // Sanitize filename (replace invalid chars for Windows, but spaces and brackets are fine)
      fileName = `${baseName.replace(/[\\/:*?"<>|]/g, '_')}.json`;
    }

    const filePath = path.join(folderPath, fileName);
    processedLocalFiles.add(fileName);

    const recordData = (tableName === 'workflows' || tableName === 'packages') ? dbRecord.data : dbRecord;
    
    // Clean system fields from the DB object to keep seed files pure
    const cleanedRecord = JSON.parse(JSON.stringify(recordData));
    delete cleanedRecord.created_at;
    delete cleanedRecord.updated_at;
    delete cleanedRecord.is_deleted;
    delete cleanedRecord.client_updated_at;

    if (fs.existsSync(filePath)) {
      try {
        const localContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (isEqual(localContent, cleanedRecord)) {
          skippedCount++;
          continue;
        }
        
        // Local is different, overwrite it
        fs.writeFileSync(filePath, JSON.stringify(cleanedRecord, null, 2), 'utf8');
        updatedCount++;
      } catch (e) {
        fs.writeFileSync(filePath, JSON.stringify(cleanedRecord, null, 2), 'utf8');
        updatedCount++;
      }
    } else {
      // New file pulled
      fs.writeFileSync(filePath, JSON.stringify(cleanedRecord, null, 2), 'utf8');
      createdCount++;
    }
  }

  // Remove orphan local files that do not exist or are marked deleted in the DB
  let deletedCount = 0;
  for (const file of localFiles) {
    if (!processedLocalFiles.has(file)) {
      const filePath = path.join(folderPath, file);
      fs.unlinkSync(filePath);
      deletedCount++;
    }
  }

  console.log(`[${tableName}] Pull complete: Created ${createdCount}, Updated ${updatedCount}, Deleted ${deletedCount} local files. (Skipped ${skippedCount} unchanged).`);
}

// STATUS action logic
async function printStatus(tableName, folderName) {
  const folderPath = path.join(__dirname, projectName, folderName);
  const localFiles = fs.existsSync(folderPath) ? fs.readdirSync(folderPath).filter(f => f.endsWith('.json')) : [];
  const existingDbRecords = await fetchTableData(tableName);
  
  let newLocal = 0;
  let newRemote = 0;
  let modified = 0;
  let synced = 0;

  const processedRemoteIds = new Set();

  for (const file of localFiles) {
    const filePath = path.join(folderPath, file);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const items = Array.isArray(content) ? content : [content];
      
      for (const item of items) {
        let recordId = item.id || file.split('.')[0];
        if (tableName === 'variables') recordId = item.name || file.split('.')[0];

        const dbRecord = existingDbRecords.find(r => {
          if (tableName === 'variables') return r.name === recordId;
          return r.id === recordId;
        });

        if (!dbRecord) {
          newLocal++;
        } else {
          processedRemoteIds.add(recordId);
          const dbData = (tableName === 'workflows' || tableName === 'packages') ? dbRecord.data : dbRecord;
          if (isEqual(item, dbData)) {
            synced++;
          } else {
            modified++;
          }
        }
      }
    } catch (e) {
      modified++;
    }
  }

  for (const dbRecord of existingDbRecords) {
    const recordId = tableName === 'variables' ? dbRecord.name : dbRecord.id;
    if (!processedRemoteIds.has(recordId)) {
      newRemote++;
    }
  }

  console.log(`[${tableName}] Synced: ${synced} | Modified: ${modified} | Only Local: ${newLocal} | Only DB: ${newRemote}`);
}

async function main() {
  if (action === 'lint') {
    try {
      execSync(`node "${path.join(__dirname, '../automa-cli/bin/lint.js')}" --project=${projectName} --vault-path="${__dirname}"`, { stdio: 'inherit' });
    } catch (e) {
      process.exit(1);
    }
    return;
  }

  if (action === 'push') {
    console.log(`Starting push to database (Diff Sync Mode) for project: ${projectName}...`);
    try {
      console.log('Running Workflow Linter...');
      execSync(`node "${path.join(__dirname, '../automa-cli/bin/lint.js')}" --project=${projectName} --vault-path="${__dirname}"`, { stdio: 'inherit' });
      console.log('Running Workflow Auto-Aligner...');
      execSync(`node "${path.join(__dirname, 'align-workflows.js')}" --project=${projectName}`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Push aborted due to pre-seed hook errors.');
      process.exit(1);
    }

    for (const table of enabledTables) {
      await pushTable(table, table);
    }
    console.log('Push complete!');
    return;
  }

  if (action === 'pull') {
    console.log(`Starting pull from database for project: ${projectName}...`);
    for (const table of enabledTables) {
      await pullTable(table, table);
    }
    console.log('Pull complete!');
    return;
  }

  if (action === 'status') {
    console.log(`Status comparison between vault and DB for project: ${projectName}...`);
    for (const table of enabledTables) {
      await printStatus(table, table);
    }
    return;
  }
}

main();
