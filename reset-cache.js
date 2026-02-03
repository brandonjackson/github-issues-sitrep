#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const dbFiles = [
  'sitrep.db',
  'sitrep.db-shm',
  'sitrep.db-wal'
];

console.log('🗑️  Resetting GitHub Sitrep cache...\n');

let deletedCount = 0;

dbFiles.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`✓ Deleted ${file}`);
      deletedCount++;
    } catch (error) {
      console.error(`✗ Failed to delete ${file}:`, error.message);
    }
  }
});

if (deletedCount === 0) {
  console.log('ℹ️  No cache files found (already clean)');
} else {
  console.log(`\n✅ Cache reset complete! Deleted ${deletedCount} file(s)`);
  console.log('   Next sync will fetch fresh data from GitHub');
}
