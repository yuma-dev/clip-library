#!/usr/bin/env node

/**
 * Modularization Validation Script
 *
 * Scans main.js to find IPC handlers that still contain substantial logic
 * instead of being thin wrappers that delegate to modules.
 *
 * Usage: node validate-modularization.js
 */

const fs = require('fs');
const path = require('path');

const MAIN_JS_PATH = path.join(__dirname, 'main.js');
const MAX_THIN_WRAPPER_LINES = 10; // Handlers with more than this are flagged

// Expected modules that handlers should delegate to
const EXPECTED_MODULES = [
  'metadataModule',
  'thumbnailsModule',
  'ffmpegModule',
  'clipsModule',
  'discordModule',
  'updaterModule',
  'fileWatcherModule',
  'dialogsModule',
  'diagnosticsModule',
  'steelSeriesModule',
  'updateSettings',
  'getDefaultKeybindings',
  'getClipLocation',
  'setClipLocation',
  'logActivity'
];

function extractHandlers(content) {
  const handlers = [];
  const regex = /ipcMain\.handle\(['"]([^'"]+)['"],\s*(?:async\s*)?\([^)]*\)\s*=>\s*{/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const handlerName = match[1];
    const startIndex = match.index;
    const startLine = content.substring(0, startIndex).split('\n').length;

    // Find the end of this handler by counting braces
    let braceCount = 1;
    let i = match.index + match[0].length;
    let handlerBody = '';

    while (i < content.length && braceCount > 0) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') braceCount--;
      if (braceCount > 0) handlerBody += content[i];
      i++;
    }

    const endLine = content.substring(0, i).split('\n').length;
    const lineCount = endLine - startLine;

    handlers.push({
      name: handlerName,
      startLine,
      endLine,
      lineCount,
      body: handlerBody.trim()
    });
  }

  return handlers;
}

function analyzeHandler(handler) {
  const { name, body, lineCount } = handler;

  // Calculate lines of actual code (excluding comments and blank lines)
  const codeLines = body.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*');
  }).length;

  // Check for complex patterns that indicate non-thin wrapper
  const hasComplexLogic =
    body.includes('for (') ||
    body.includes('while (') ||
    body.includes('switch (') ||
    body.match(/if \(/g)?.length > 2 || // More than 2 if statements
    body.includes('Promise(') ||
    body.includes('await fs.') ||
    body.includes('path.join(') && lineCount > 5;

  // Check if it's a simple delegation to a module or function
  const delegatesToModule = EXPECTED_MODULES.some(mod =>
    body.includes(`${mod}.`) ||
    body.includes(`await ${mod}.`) ||
    body.includes(`${mod}(`) ||
    body.includes(`return ${mod}(`)
  );

  // Special case: extremely simple one-liners are acceptable (e.g., app.getVersion())
  const isOneLineWrapper = codeLines <= 1 && !hasComplexLogic;

  const isThinWrapper = (delegatesToModule || isOneLineWrapper) && !hasComplexLogic && codeLines <= MAX_THIN_WRAPPER_LINES;

  return {
    ...handler,
    codeLines,
    delegatesToModule,
    hasComplexLogic,
    isThinWrapper
  };
}

function categorizeByModule(handlers) {
  const categories = {
    'FFmpeg': [],
    'Thumbnails': [],
    'Metadata': [],
    'Clips': [],
    'Settings': [],
    'Discord': [],
    'Dialogs': [],
    'Other': []
  };

  handlers.forEach(handler => {
    if (handler.name.includes('export') || handler.name.includes('ffmpeg')) {
      categories.FFmpeg.push(handler);
    } else if (handler.name.includes('thumbnail')) {
      categories.Thumbnails.push(handler);
    } else if (handler.name.includes('trim') || handler.name.includes('speed') ||
               handler.name.includes('volume') || handler.name.includes('tags') ||
               handler.name.includes('custom-name') || handler.name.includes('game-icon')) {
      categories.Metadata.push(handler);
    } else if (handler.name.includes('clips') || handler.name.includes('clip-list')) {
      categories.Clips.push(handler);
    } else if (handler.name.includes('settings') || handler.name.includes('keybindings')) {
      categories.Settings.push(handler);
    } else if (handler.name.includes('discord')) {
      categories.Discord.push(handler);
    } else if (handler.name.includes('dialog') || handler.name.includes('folder')) {
      categories.Dialogs.push(handler);
    } else {
      categories.Other.push(handler);
    }
  });

  return categories;
}

function main() {
  console.log('🔍 Modularization Validation\n');
  console.log('Scanning main.js for IPC handlers...\n');

  // Read main.js
  const content = fs.readFileSync(MAIN_JS_PATH, 'utf8');

  // Extract all handlers
  const handlers = extractHandlers(content);
  console.log(`Found ${handlers.length} IPC handlers\n`);

  // Analyze each handler
  const analyzed = handlers.map(analyzeHandler);

  // Separate into thin wrappers and needs extraction
  const thinWrappers = analyzed.filter(h => h.isThinWrapper);
  const needsExtraction = analyzed.filter(h => !h.isThinWrapper);

  // Categorize
  const categories = categorizeByModule(needsExtraction);

  // Report
  console.log('━'.repeat(80));
  console.log(`✅ Thin Wrappers: ${thinWrappers.length}`);
  console.log(`⚠️  Needs Extraction: ${needsExtraction.length}`);
  console.log('━'.repeat(80));

  if (needsExtraction.length === 0) {
    console.log('\n🎉 All handlers are thin wrappers! Modularization complete.\n');
    return;
  }

  console.log('\n📋 Handlers that need extraction:\n');

  Object.entries(categories).forEach(([category, handlers]) => {
    if (handlers.length === 0) return;

    console.log(`\n${category} (${handlers.length}):`);
    console.log('─'.repeat(80));

    handlers.forEach(h => {
      const reasons = [];
      if (!h.delegatesToModule) reasons.push('no module delegation');
      if (h.hasComplexLogic) reasons.push('complex logic');
      if (h.codeLines > MAX_THIN_WRAPPER_LINES) reasons.push(`${h.codeLines} lines of code`);

      console.log(`  📍 ${h.name} (lines ${h.startLine}-${h.endLine})`);
      console.log(`     Issues: ${reasons.join(', ')}`);

      // Show a snippet of the logic
      const snippet = h.body.split('\n').slice(0, 3).map(l => l.trim()).join(' ');
      if (snippet.length > 70) {
        console.log(`     Preview: ${snippet.substring(0, 67)}...`);
      } else {
        console.log(`     Preview: ${snippet}`);
      }
      console.log();
    });
  });

  // Summary with recommendations
  console.log('━'.repeat(80));
  console.log('\n💡 Recommendations:\n');

  const moduleRecommendations = {
    'FFmpeg': 'main/ffmpeg.js',
    'Thumbnails': 'main/thumbnails.js',
    'Metadata': 'main/metadata.js',
    'Clips': 'main/clips.js',
    'Settings': 'utils/settings-manager.js',
    'Discord': 'main/discord.js',
    'Dialogs': 'Consider creating main/dialogs.js',
    'Other': 'Review and categorize these handlers'
  };

  Object.entries(categories).forEach(([category, handlers]) => {
    if (handlers.length > 0) {
      console.log(`  • ${category}: Extract to ${moduleRecommendations[category]}`);
      console.log(`    Handlers: ${handlers.map(h => h.name).join(', ')}`);
      console.log();
    }
  });

  console.log('━'.repeat(80));
  console.log(`\n📊 Progress: ${thinWrappers.length}/${handlers.length} handlers modularized (${Math.round(thinWrappers.length / handlers.length * 100)}%)\n`);
}

main();
