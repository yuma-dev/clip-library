#!/usr/bin/env node

/**
 * Renderer.js Modularization Validation Script
 *
 * Analyzes renderer.js modularization progress, categorizes remaining functions,
 * and detects dependency violations when functions are moved to modules.
 *
 * Usage:
 *   node validate-renderer-modularization.js
 *   node validate-renderer-modularization.js --verbose
 *   node validate-renderer-modularization.js --json
 *   node validate-renderer-modularization.js --category "Tags Management"
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

// ============================================================================
// CONFIGURATION
// ============================================================================

const RENDERER_JS_PATH = path.join(__dirname, 'renderer.js');
const RENDERER_DIR = path.join(__dirname, 'renderer');
const SNAPSHOT_FILE = path.join(__dirname, '.modularization-snapshot.json');

// Category definitions with patterns, target modules, and priorities
const CATEGORIES = {
  'Video Player Controls': {
    patterns: [/\bplayer\b/i, /\bVideo\b/, /\bplayback\b/i, /\bfullscreen\b/i, /\bplay\b/i, /\bpause\b/i],
    targetModule: 'renderer/video-player.js',
    priority: 0,
    complexity: 'medium',
    status: 'IN_PROGRESS'
  },
  'Speed Controls': {
    patterns: [/\bspeed\b/i, /\bSpeed\b/],
    targetModule: 'renderer/video-player.js',
    priority: 0,
    complexity: 'low',
    status: 'EXTRACTED'
  },
  'Volume Controls': {
    patterns: [/\bvolume\b/i, /\bVolume\b/, /\baudio\b/i, /\bgain\b/i],
    targetModule: 'renderer/video-player.js',
    priority: 0,
    complexity: 'medium',
    status: 'EXTRACTED'
  },
  'Trim Controls': {
    patterns: [/\btrim\b/i, /\bTrim\b/],
    targetModule: 'renderer/video-player.js',
    priority: 0,
    complexity: 'medium',
    status: 'EXTRACTED'
  },
  'Tags Management': {
    patterns: [/\btag\b/i, /\bTag\b/, /tags/i],
    targetModule: 'renderer/tag-manager.js',
    priority: 1,
    complexity: 'medium'
  },
  'Export Operations': {
    patterns: [/\bexport\b/i, /\bExport\b/],
    targetModule: 'renderer/export-manager.js',
    priority: 2,
    complexity: 'medium'
  },
  'Search & Filtering': {
    patterns: [/\bsearch\b/i, /\bfilter\b/i, /\bFilter\b/],
    targetModule: 'renderer/search-manager.js',
    priority: 1,
    complexity: 'low'
  },
  'Clip Grid Management': {
    patterns: [/\brenderClip/i, /\bcreateClip/i, /\bclipElement\b/i, /\bgrid\b/i, /\bclipGrid\b/i],
    targetModule: 'renderer/clip-grid.js',
    priority: 3,
    complexity: 'high'
  },
  'Thumbnail Management': {
    patterns: [/\bthumbnail\b/i, /\bThumbnail\b/],
    targetModule: null,
    priority: 4,
    complexity: 'low',
    note: 'Handled by main process'
  },
  'Settings Management': {
    patterns: [/\bsetting\b/i, /\bSettings\b/, /\bpreference\b/i],
    targetModule: 'renderer/settings-manager.js',
    priority: 2,
    complexity: 'medium'
  },
  'Diagnostics & System': {
    patterns: [/\bdiagnostic/i, /\bDiagnostic\b/, /\bupdate\b/i],
    targetModule: 'renderer/diagnostics.js',
    priority: 4,
    complexity: 'low'
  },
  'Grid Navigation': {
    patterns: [/\bgrid.*nav/i, /\bmoveGrid/i, /\bnavigation\b/i],
    targetModule: 'renderer/grid-navigation.js',
    priority: 2,
    complexity: 'low'
  },
  'Keyboard/Gamepad': {
    patterns: [/\bkeybind/i, /\bgamepad\b/i, /\bcontroller\b/i],
    targetModule: null,
    priority: 0,
    complexity: 'low',
    status: 'EXTRACTED'
  },
  'Discord Integration': {
    patterns: [/\bdiscord\b/i, /\bDiscord\b/, /\bRPC\b/],
    targetModule: 'renderer/discord-integration.js',
    priority: 4,
    complexity: 'low'
  },
  'Context Menus & Dialogs': {
    patterns: [/\bcontext.*menu\b/i, /\btooltip\b/i, /\balert\b/i, /\bconfirm\b/i, /\bdialog\b/i],
    targetModule: 'renderer/dialogs-ui.js',
    priority: 3,
    complexity: 'low'
  },
  'Clip Selection': {
    patterns: [/\bselection\b/i, /\bselect.*clip\b/i, /\bpreview\b/i],
    targetModule: 'renderer/selection-manager.js',
    priority: 2,
    complexity: 'medium'
  }
};

// Known DOM elements used to categorize functions
const KNOWN_DOM_ELEMENTS = [
  'videoPlayer', 'clipGrid', 'settingsModal', 'exportModal',
  'tagManagement', 'searchInput', 'clipTitle', 'progressBar',
  'volumeSlider', 'speedSlider', 'trimStart', 'trimEnd'
];

// ============================================================================
// MAIN VALIDATOR CLASS
// ============================================================================

class RendererModularizationValidator {
  constructor() {
    this.rendererFunctions = [];
    this.modules = new Map();
    this.categorizedFunctions = new Map();
    this.violations = [];
    this.rendererContent = '';
    this.rendererAST = null;
    this.snapshot = null;
    this.comparison = null;
  }

  // ==========================================================================
  // PHASE 1: FUNCTION EXTRACTION
  // ==========================================================================

  parseRenderer() {
    console.log('📖 Phase 1: Parsing renderer.js...\n');

    // Read renderer.js
    this.rendererContent = fs.readFileSync(RENDERER_JS_PATH, 'utf8');

    // Parse with Acorn
    try {
      this.rendererAST = acorn.parse(this.rendererContent, {
        ecmaVersion: 2022,
        sourceType: 'script',
        locations: true
      });
    } catch (error) {
      console.error('❌ Failed to parse renderer.js:', error.message);
      process.exit(1);
    }

    // Extract functions using AST walker
    this.extractFunctions(this.rendererAST);

    console.log(`✅ Found ${this.rendererFunctions.length} functions in renderer.js\n`);
  }

  extractFunctions(ast) {
    const self = this;
    const lines = this.rendererContent.split('\n');

    walk.simple(ast, {
      FunctionDeclaration(node) {
        if (node.id && node.id.name) {
          self.addFunction({
            name: node.id.name,
            type: 'FunctionDeclaration',
            startLine: node.loc.start.line,
            endLine: node.loc.end.line,
            lineCount: node.loc.end.line - node.loc.start.line + 1,
            node: node,
            body: node.body,
            async: node.async
          });
        }
      },

      VariableDeclarator(node) {
        // Match: const funcName = function() {}
        // Match: const funcName = () => {}
        // Match: const funcName = async () => {}
        if (node.id && node.id.name && node.init) {
          if (node.init.type === 'FunctionExpression' ||
              node.init.type === 'ArrowFunctionExpression') {
            self.addFunction({
              name: node.id.name,
              type: 'VariableDeclarator',
              startLine: node.loc.start.line,
              endLine: node.loc.end.line,
              lineCount: node.loc.end.line - node.loc.start.line + 1,
              node: node,
              body: node.init.body,
              async: node.init.async
            });
          }
        }
      },

      ClassDeclaration(node) {
        if (node.id && node.id.name) {
          // Track class itself
          self.addFunction({
            name: node.id.name,
            type: 'ClassDeclaration',
            startLine: node.loc.start.line,
            endLine: node.loc.end.line,
            lineCount: node.loc.end.line - node.loc.start.line + 1,
            node: node,
            body: node.body,
            async: false
          });

          // Track class methods
          if (node.body && node.body.body) {
            node.body.body.forEach(method => {
              if (method.type === 'MethodDefinition' && method.key) {
                const methodName = method.key.name || method.key.value;
                if (methodName) {
                  self.addFunction({
                    name: `${node.id.name}.${methodName}`,
                    type: 'MethodDefinition',
                    startLine: method.loc.start.line,
                    endLine: method.loc.end.line,
                    lineCount: method.loc.end.line - method.loc.start.line + 1,
                    node: method,
                    body: method.value.body,
                    async: method.value.async,
                    className: node.id.name
                  });
                }
              }
            });
          }
        }
      }
    });
  }

  addFunction(funcData) {
    // Skip functions that are too small (likely helpers or one-liners)
    if (funcData.lineCount < 2) return;

    // Skip anonymous functions
    if (!funcData.name || funcData.name.startsWith('_')) return;

    this.rendererFunctions.push(funcData);
  }

  // ==========================================================================
  // PHASE 2: MODULE DETECTION
  // ==========================================================================

  scanModules() {
    console.log('🔍 Phase 2: Scanning renderer modules...\n');

    if (!fs.existsSync(RENDERER_DIR)) {
      console.log('⚠️  renderer/ directory not found\n');
      return;
    }

    const files = fs.readdirSync(RENDERER_DIR).filter(f => f.endsWith('.js'));

    files.forEach(file => {
      const modulePath = path.join(RENDERER_DIR, file);
      const moduleName = path.basename(file, '.js');
      this.scanModule(moduleName, modulePath);
    });

    console.log(`✅ Scanned ${this.modules.size} modules\n`);
  }

  scanModule(moduleName, modulePath) {
    const content = fs.readFileSync(modulePath, 'utf8');

    let ast;
    try {
      ast = acorn.parse(content, {
        ecmaVersion: 2022,
        sourceType: 'script',
        locations: true
      });
    } catch (error) {
      console.warn(`⚠️  Failed to parse ${moduleName}: ${error.message}`);
      return;
    }

    const moduleData = {
      name: moduleName,
      path: modulePath,
      functions: [],
      exports: []
    };

    // Extract exported functions
    this.extractModuleExports(ast, content, moduleData);

    // Extract all functions in the module
    this.extractModuleFunctions(ast, moduleData);

    this.modules.set(moduleName, moduleData);
  }

  extractModuleExports(ast, content, moduleData) {
    walk.simple(ast, {
      AssignmentExpression(node) {
        // Match: module.exports = { func1, func2, ... }
        // Match: module.exports.func = ...
        if (node.left.type === 'MemberExpression') {
          const obj = node.left.object;
          const prop = node.left.property;

          // module.exports = { ... }
          if (obj.type === 'Identifier' &&
              obj.name === 'module' &&
              prop && prop.name === 'exports') {
            if (node.right.type === 'ObjectExpression') {
              node.right.properties.forEach(p => {
                // Handle both shorthand (init) and regular (init: init) syntax
                if (p.type === 'Property') {
                  if (p.key && p.key.name) {
                    moduleData.exports.push(p.key.name);
                  } else if (p.key && p.key.type === 'Identifier') {
                    moduleData.exports.push(p.key.name);
                  }
                }
              });
            }
          }

          // module.exports.funcName = ...
          if (obj.type === 'MemberExpression' &&
              obj.object && obj.object.name === 'module' &&
              obj.property && obj.property.name === 'exports' &&
              prop && prop.name) {
            moduleData.exports.push(prop.name);
          }
        }
      }
    });
  }

  extractModuleFunctions(ast, moduleData) {
    walk.simple(ast, {
      FunctionDeclaration(node) {
        if (node.id && node.id.name) {
          moduleData.functions.push(node.id.name);
        }
      },
      VariableDeclarator(node) {
        if (node.id && node.id.name && node.init &&
            (node.init.type === 'FunctionExpression' ||
             node.init.type === 'ArrowFunctionExpression')) {
          moduleData.functions.push(node.id.name);
        }
      }
    });
  }

  // ==========================================================================
  // PHASE 3: SMART CATEGORIZATION
  // ==========================================================================

  categorizeFunctions() {
    console.log('🏷️  Phase 3: Categorizing functions...\n');

    // Initialize categories
    Object.keys(CATEGORIES).forEach(cat => {
      this.categorizedFunctions.set(cat, []);
    });
    this.categorizedFunctions.set('Uncategorized', []);

    // Filter out functions that are already extracted
    const remainingFunctions = this.rendererFunctions.filter(func => {
      return !this.isFunctionExtracted(func.name);
    });

    // Categorize each function
    remainingFunctions.forEach(func => {
      const category = this.categorizeFunction(func);
      this.categorizedFunctions.get(category).push(func);
    });

    console.log(`✅ Categorized ${remainingFunctions.length} remaining functions\n`);
  }

  isFunctionExtracted(funcName) {
    for (const [moduleName, moduleData] of this.modules) {
      if (moduleData.exports.includes(funcName) || moduleData.functions.includes(funcName)) {
        return true;
      }
    }
    return false;
  }

  categorizeFunction(func) {
    // Strategy 1: Name-based pattern matching (highest priority)
    const nameCategory = this.categorizeByName(func.name);
    if (nameCategory !== 'Uncategorized') {
      return nameCategory;
    }

    // Strategy 2: IPC call analysis
    const ipcCategory = this.categorizeByIPC(func);
    if (ipcCategory !== 'Uncategorized') {
      return ipcCategory;
    }

    // Strategy 3: DOM element usage
    const domCategory = this.categorizeByDOM(func);
    if (domCategory !== 'Uncategorized') {
      return domCategory;
    }

    return 'Uncategorized';
  }

  categorizeByName(funcName) {
    let bestMatch = { category: 'Uncategorized', priority: 999 };

    for (const [categoryName, config] of Object.entries(CATEGORIES)) {
      if (config.status === 'EXTRACTED') continue;

      for (const pattern of config.patterns) {
        if (pattern.test(funcName)) {
          if (config.priority < bestMatch.priority) {
            bestMatch = { category: categoryName, priority: config.priority };
          }
        }
      }
    }

    return bestMatch.category;
  }

  categorizeByIPC(func) {
    if (!func.body) return 'Uncategorized';

    const ipcCalls = [];
    try {
      walk.simple(func.body, {
        CallExpression(node) {
          if (node.callee.type === 'MemberExpression' &&
              node.callee.property && node.callee.property.name === 'invoke' &&
              node.arguments[0] && node.arguments[0].type === 'Literal') {
            ipcCalls.push(node.arguments[0].value);
          }
        }
      });
    } catch (error) {
      // Ignore walk errors for malformed AST nodes
    }

    // Map IPC calls to categories
    for (const ipcCall of ipcCalls) {
      if (ipcCall.includes('export')) return 'Export Operations';
      if (ipcCall.includes('tag')) return 'Tags Management';
      if (ipcCall.includes('thumbnail')) return 'Thumbnail Management';
      if (ipcCall.includes('trim')) return 'Trim Controls';
      if (ipcCall.includes('speed')) return 'Speed Controls';
      if (ipcCall.includes('volume')) return 'Volume Controls';
    }

    return 'Uncategorized';
  }

  categorizeByDOM(func) {
    if (!func.body) return 'Uncategorized';

    const domElements = new Set();
    try {
      walk.simple(func.body, {
        Identifier(node) {
          if (KNOWN_DOM_ELEMENTS.includes(node.name)) {
            domElements.add(node.name);
          }
        }
      });
    } catch (error) {
      // Ignore walk errors
    }

    // Map DOM elements to categories
    if (domElements.has('clipGrid')) return 'Clip Grid Management';
    if (domElements.has('videoPlayer')) return 'Video Player Controls';
    if (domElements.has('settingsModal')) return 'Settings Management';
    if (domElements.has('tagManagement')) return 'Tags Management';
    if (domElements.has('searchInput')) return 'Search & Filtering';

    return 'Uncategorized';
  }

  // ==========================================================================
  // PHASE 4: VIOLATION DETECTION
  // ==========================================================================

  detectViolations() {
    console.log('⚠️  Phase 4: Detecting violations...\n');

    this.violations = [];

    // Type 1: Direct calls to extracted functions
    this.detectDirectCallViolations();

    // Type 2: Duplicate definitions
    this.detectDuplicateDefinitions();

    // Type 3: Missing imports
    this.detectMissingImports();

    console.log(`✅ Found ${this.violations.length} violations\n`);
  }

  toCamelCase(str) {
    return str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
  }

  detectDirectCallViolations() {
    // Get all extracted function names
    const extractedFunctions = new Map(); // funcName -> moduleName

    for (const [moduleName, moduleData] of this.modules) {
      moduleData.exports.forEach(funcName => {
        extractedFunctions.set(funcName, moduleName);
      });
    }

    // Check each remaining function for direct calls to extracted functions
    const self = this;
    this.rendererFunctions.forEach(func => {
      if (!func.body) return;

      try {
        walk.simple(func.body, {
          CallExpression(node) {
            // Only check direct calls (Identifier), ignore method calls (MemberExpression)
            // e.g. check 'init()', ignore 'manager.init()'
            if (node.callee.type === 'Identifier') {
              const calleeName = node.callee.name;
              
              if (extractedFunctions.has(calleeName)) {
                const moduleName = extractedFunctions.get(calleeName);
                const variableName = self.toCamelCase(moduleName) + 'Module';
                
                self.violations.push({
                  type: 'direct_call_to_extracted',
                  functionName: func.name,
                  callee: calleeName,
                  module: moduleName,
                  line: func.startLine,
                  fix: `${variableName}.${calleeName}()`
                });
              }
            }
          }
        });
      } catch (error) {
        // Ignore walk errors
      }
    });

    // Also check for function references in event listener registrations
    // Look for patterns like: addEventListener("click", functionName)
    const lines = this.rendererContent.split('\n');
    lines.forEach((line, lineIndex) => {
      // Match addEventListener calls with function references
      const eventListenerMatch = line.match(/addEventListener\s*\(\s*["'][^"']*["']\s*,\s*(\w+)\s*\)/);
      if (eventListenerMatch) {
        const funcName = eventListenerMatch[1];
        if (extractedFunctions.has(funcName)) {
          const moduleName = extractedFunctions.get(funcName);
          const variableName = self.toCamelCase(moduleName) + 'Module';
          
          self.violations.push({
            type: 'direct_call_to_extracted',
            functionName: 'event listener registration',
            callee: funcName,
            module: moduleName,
            line: lineIndex + 1,
            fix: `${variableName}.${funcName}`
          });
        }
      }
    });
  }

  getCalleeName(node) {
    if (node.type === 'Identifier') {
      return node.name;
    }
    if (node.type === 'MemberExpression' && node.property) {
      return node.property.name;
    }
    return null;
  }

  isModulePrefixedCall(node) {
    // Check if call is like: moduleName.funcName()
    if (node.callee.type === 'MemberExpression' &&
        node.callee.object &&
        node.callee.object.name) {
      const objName = node.callee.object.name;
      // Check if object name ends with 'Module' or matches a known module
      return objName.endsWith('Module') || this.modules.has(objName);
    }
    return false;
  }

  detectDuplicateDefinitions() {
    for (const func of this.rendererFunctions) {
      for (const [moduleName, moduleData] of this.modules) {
        if (moduleData.functions.includes(func.name)) {
          this.violations.push({
            type: 'duplicate_definition',
            function: func.name,
            module: moduleName,
            rendererLine: func.startLine,
            fix: `Remove ${func.name} from renderer.js (already in ${moduleName})`
          });
        }
      }
    }
  }

  detectMissingImports() {
    // Extract all require statements from renderer.js
    const imports = new Set();
    const requireRegex = /require\(['"]\.\/renderer\/([^'"]+)['"]\)/g;
    let match;
    while ((match = requireRegex.exec(this.rendererContent)) !== null) {
      imports.add(match[1]);
    }

    // Check which modules are used but not imported
    const usedModules = new Set();
    for (const [moduleName] of this.modules) {
      const moduleVarPattern = new RegExp(`\\b${moduleName}Module\\.`, 'g');
      if (moduleVarPattern.test(this.rendererContent)) {
        usedModules.add(moduleName);
      }
    }

    for (const moduleName of usedModules) {
      if (!imports.has(moduleName)) {
        this.violations.push({
          type: 'missing_import',
          module: moduleName,
          fix: `const ${moduleName}Module = require('./renderer/${moduleName}');`
        });
      }
    }
  }

  // ==========================================================================
  // SNAPSHOT & COMPARISON
  // ==========================================================================

  loadSnapshot() {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      try {
        this.snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      } catch (e) {
        console.warn('⚠️  Could not read previous snapshot, starting fresh.');
      }
    }
  }

  saveSnapshot() {
    const data = this.generateJSON();
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
  }

  compareWithSnapshot() {
    if (!this.snapshot) return null;

    const prevFunctions = new Set(this.snapshot.summary.allFunctions || []);
    const currFunctions = new Set(this.rendererFunctions.map(f => f.name));
    const allModuleFunctions = new Set();
    
    // Collect all functions currently in modules
    for (const [name, moduleData] of this.modules) {
      moduleData.functions.forEach(f => allModuleFunctions.add(f));
    }

    const removedFromRenderer = [...prevFunctions].filter(f => !currFunctions.has(f));
    const movedToModule = removedFromRenderer.filter(f => allModuleFunctions.has(f));
    const missing = removedFromRenderer.filter(f => !allModuleFunctions.has(f));
    const added = [...currFunctions].filter(f => !prevFunctions.has(f));

    return {
      moved: movedToModule,
      missing: missing,
      added: added,
      violationChange: this.violations.length - this.snapshot.summary.violationCount
    };
  }

  // ==========================================================================
  // PHASE 5: REPORT GENERATION
  // ==========================================================================

  generateReport(options = {}) {
    this.comparison = this.compareWithSnapshot();

    console.log('📊 Phase 5: Generating report...\n');
    console.log('='.repeat(80));
    console.log('📊 Renderer.js Modularization Report');
    console.log('='.repeat(80));
    console.log();

    this.printSummary();
    this.printComparison();
    this.printModuleProgress();
    this.printCategorizedFunctions(options);
    this.printViolations(options);
    this.printRecommendations();

    console.log('='.repeat(80));
    console.log();
  }

  printSummary() {
    const totalFunctions = this.rendererFunctions.length;
    const extractedCount = totalFunctions - this.categorizedFunctions.get('Uncategorized').length -
                           Array.from(this.categorizedFunctions.values())
                                .filter((funcs, idx) => {
                                  const catName = Array.from(this.categorizedFunctions.keys())[idx];
                                  return catName !== 'Uncategorized';
                                })
                                .reduce((sum, funcs) => sum + funcs.length, 0);
    const remaining = totalFunctions - extractedCount;
    const percentage = Math.round((extractedCount / totalFunctions) * 100);

    console.log('SUMMARY');
    console.log('-'.repeat(80));
    console.log(`Total functions in renderer.js: ${totalFunctions}`);
    console.log(`Already extracted to modules: ${extractedCount} (${percentage}%)`);
    console.log(`Remaining in renderer.js: ${remaining} (${100 - percentage}%)`);
    console.log(`Dependency violations found: ${this.violations.length}`);
    console.log();
  }

  printComparison() {
    if (!this.comparison) return;

    console.log('CHANGES SINCE LAST RUN');
    console.log('-'.repeat(80));
    
    if (this.comparison.moved.length > 0) {
      console.log(`✅ Successfully moved ${this.comparison.moved.length} functions:`);
      console.log(`   ${this.comparison.moved.join(', ')}`);
    }

    if (this.comparison.missing.length > 0) {
      console.log(`❌ WARNING: ${this.comparison.missing.length} functions removed but NOT found in modules:`);
      this.comparison.missing.forEach(f => console.log(`   - ${f}`));
    }

    if (this.comparison.added.length > 0) {
      console.log(`🆕 Added ${this.comparison.added.length} new functions to renderer.js`);
    }

    const vChange = this.comparison.violationChange;
    if (vChange !== 0) {
      const sign = vChange > 0 ? '+' : '';
      console.log(`⚠️  Violations change: ${sign}${vChange}`);
    }
    console.log();
  }

  printModuleProgress() {
    console.log('EXTRACTION PROGRESS BY MODULE');
    console.log('-'.repeat(80));

    for (const [moduleName, moduleData] of this.modules) {
      const status = this.getModuleStatus(moduleName);
      const icon = status === 'COMPLETE' ? '✅' : status === 'IN_PROGRESS' ? '⏳' : '❌';

      console.log(`${icon} ${this.capitalize(moduleName)} (renderer/${moduleName}.js)`);
      console.log(`   Status: ${status}`);
      console.log(`   Exports: ${moduleData.exports.length} functions`);
      console.log();
    }
  }

  getModuleStatus(moduleName) {
    // Check category configuration for status
    for (const [catName, config] of Object.entries(CATEGORIES)) {
      if (config.targetModule && config.targetModule.includes(moduleName)) {
        return config.status || 'COMPLETE';
      }
    }
    return 'UNKNOWN';
  }

  printCategorizedFunctions(options) {
    console.log('FUNCTIONS REMAINING IN RENDERER.JS');
    console.log('-'.repeat(80));
    console.log();

    // Filter by category if specified
    let categoriesToShow = Array.from(this.categorizedFunctions.entries());
    if (options.category) {
      categoriesToShow = categoriesToShow.filter(([name]) => name === options.category);
    }

    // Sort by priority
    categoriesToShow.sort((a, b) => {
      const priorityA = CATEGORIES[a[0]]?.priority ?? 999;
      const priorityB = CATEGORIES[b[0]]?.priority ?? 999;
      return priorityA - priorityB;
    });

    for (const [categoryName, functions] of categoriesToShow) {
      if (functions.length === 0) continue;

      const config = CATEGORIES[categoryName] || {};
      const priorityLabel = config.priority !== undefined ? `Priority: ${this.getPriorityLabel(config.priority)}` : '';
      const targetModule = config.targetModule || 'TBD';

      console.log(`📦 ${categoryName} (${functions.length} functions) [${priorityLabel}]`);
      console.log(`   Target: ${targetModule}`);
      console.log(`   Complexity: ${config.complexity || 'unknown'}`);
      console.log();

      // Show functions
      const functionsToShow = options.verbose ? functions : functions.slice(0, 10);
      console.log('   Functions:');
      functionsToShow.forEach(func => {
        console.log(`   ├─ ${func.name}() - line ${func.startLine} (${func.lineCount} lines)`);
      });

      if (functions.length > 10 && !options.verbose) {
        console.log(`   └─ ... (${functions.length - 10} more)`);
      }
      console.log();
    }
  }

  getPriorityLabel(priority) {
    if (priority === 0) return 'DONE';
    if (priority === 1) return 'HIGH';
    if (priority === 2) return 'MEDIUM';
    return 'LOW';
  }

  printViolations(options) {
    if (this.violations.length === 0) {
      console.log('✅ No dependency violations found!');
      console.log();
      return;
    }

    console.log('DEPENDENCY VIOLATIONS');
    console.log('-'.repeat(80));
    console.log();

    // Group by type
    const byType = {
      direct_call_to_extracted: [],
      duplicate_definition: [],
      missing_import: []
    };

    this.violations.forEach(v => {
      if (byType[v.type]) {
        byType[v.type].push(v);
      }
    });

    // Print each type
    if (byType.direct_call_to_extracted.length > 0) {
      console.log(`⚠️  Direct Calls to Extracted Functions (${byType.direct_call_to_extracted.length} found)`);
      console.log();

      const toShow = options.verbose ? byType.direct_call_to_extracted : byType.direct_call_to_extracted.slice(0, 5);
      toShow.forEach((v, idx) => {
        console.log(`${idx + 1}. ${v.functionName}() → ${v.callee}()`);
        console.log(`   Line ${v.line} in renderer.js`);
        console.log(`   Issue: ${v.callee} is now in ${v.module}`);
        console.log(`   Fix: ${v.fix}`);
        console.log();
      });

      if (byType.direct_call_to_extracted.length > 5 && !options.verbose) {
        console.log(`   ... (${byType.direct_call_to_extracted.length - 5} more violations)`);
        console.log();
      }
    }

    if (byType.duplicate_definition.length > 0) {
      console.log(`⚠️  Duplicate Definitions (${byType.duplicate_definition.length} found)`);
      console.log();

      byType.duplicate_definition.forEach((v, idx) => {
        console.log(`${idx + 1}. ${v.function}() defined in both renderer.js and ${v.module}`);
        console.log(`   renderer.js line ${v.rendererLine}`);
        console.log(`   Fix: ${v.fix}`);
        console.log();
      });
    }

    if (byType.missing_import.length > 0) {
      console.log(`⚠️  Missing Imports (${byType.missing_import.length} found)`);
      console.log();

      byType.missing_import.forEach((v, idx) => {
        console.log(`${idx + 1}. renderer.js uses ${v.module} but doesn't import it`);
        console.log(`   Fix: ${v.fix}`);
        console.log();
      });
    }
  }

  printRecommendations() {
    console.log('RECOMMENDED EXTRACTION ORDER');
    console.log('-'.repeat(80));
    console.log();

    // Get categories with functions, sorted by priority
    const recommendations = Array.from(this.categorizedFunctions.entries())
      .filter(([name, funcs]) => funcs.length > 0 && name !== 'Uncategorized')
      .map(([name, funcs]) => ({
        name,
        count: funcs.length,
        config: CATEGORIES[name] || {},
        functions: funcs
      }))
      .filter(item => !item.config.status || item.config.status !== 'EXTRACTED')
      .sort((a, b) => (a.config.priority || 999) - (b.config.priority || 999));

    if (recommendations.length === 0) {
      console.log('🎉 No more functions to extract! Modularization is complete.');
      console.log();
      return;
    }

    console.log('Phase 1 (High Priority - Low Risk):');
    recommendations
      .filter(r => r.config.priority === 1)
      .forEach((r, idx) => {
        const estimatedLines = r.functions.reduce((sum, f) => sum + f.lineCount, 0);
        console.log(`  ${idx + 1}. ${r.config.targetModule || 'TBD'} (${r.count} functions)`);
        console.log(`     - ${r.config.complexity || 'unknown'} complexity`);
        console.log(`     - Reduces renderer.js by ~${estimatedLines} lines`);
        console.log();
      });

    console.log('Phase 2 (Medium Priority):');
    recommendations
      .filter(r => r.config.priority === 2)
      .forEach((r, idx) => {
        const estimatedLines = r.functions.reduce((sum, f) => sum + f.lineCount, 0);
        console.log(`  ${idx + 1}. ${r.config.targetModule || 'TBD'} (${r.count} functions)`);
        console.log(`     - ${r.config.complexity || 'unknown'} complexity`);
        console.log(`     - Reduces renderer.js by ~${estimatedLines} lines`);
        console.log();
      });

    console.log('Phase 3 (Lower Priority - Higher Risk):');
    recommendations
      .filter(r => r.config.priority >= 3)
      .forEach((r, idx) => {
        const estimatedLines = r.functions.reduce((sum, f) => sum + f.lineCount, 0);
        console.log(`  ${idx + 1}. ${r.config.targetModule || 'TBD'} (${r.count} functions)`);
        console.log(`     - ${r.config.complexity || 'unknown'} complexity`);
        console.log(`     - Reduces renderer.js by ~${estimatedLines} lines`);
        console.log();
      });

    console.log('NEXT STEPS');
    console.log('-'.repeat(80));
    console.log();
    console.log('Immediate Actions:');
    if (this.violations.length > 0) {
      console.log(`  1. Fix ${this.violations.length} dependency violations (see list above)`);
    }
    console.log('  2. Complete video-player.js extraction if in progress');
    console.log('  3. Verify all tests pass');
    console.log();

    if (recommendations.length > 0) {
      const nextModule = recommendations[0];
      console.log('Recommended Next Module:');
      console.log(`  → ${nextModule.config.targetModule || 'TBD'}`);
      console.log(`    - Extract ${nextModule.count} ${nextModule.name.toLowerCase()} functions`);
      console.log(`    - ${nextModule.config.complexity} complexity, high impact`);
      console.log(`    - Pattern: Follow video-player.js structure`);
      console.log();
    }
  }

  generateJSON() {
    const totalFunctions = this.rendererFunctions.length;
    const categorizedCount = Array.from(this.categorizedFunctions.values())
      .reduce((sum, funcs) => sum + funcs.length, 0);
    const extractedCount = totalFunctions - categorizedCount;

    return {
      summary: {
        totalFunctions,
        extractedCount,
        remainingCount: totalFunctions - extractedCount,
        extractionPercentage: Math.round((extractedCount / totalFunctions) * 100),
        violationCount: this.violations.length,
        allFunctions: this.rendererFunctions.map(f => f.name) // Store all function names
      },
      modules: Array.from(this.modules.entries()).map(([name, data]) => ({
        name,
        path: data.path,
        exportCount: data.exports.length,
        exports: data.exports,
        status: this.getModuleStatus(name)
      })),
      categories: Array.from(this.categorizedFunctions.entries()).map(([name, funcs]) => ({
        name,
        functionCount: funcs.length,
        targetModule: CATEGORIES[name]?.targetModule || null,
        priority: CATEGORIES[name]?.priority || 999,
        complexity: CATEGORIES[name]?.complexity || 'unknown',
        functions: funcs.map(f => ({
          name: f.name,
          startLine: f.startLine,
          endLine: f.endLine,
          lineCount: f.lineCount,
          type: f.type,
          async: f.async
        }))
      })),
      violations: this.violations
    };
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  capitalize(str) {
    return str.split('-').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const options = {
    verbose: args.includes('--verbose') || args.includes('-v'),
    json: args.includes('--json') || args.includes('-j'),
    category: null
  };

  // Parse --category option
  const categoryIndex = args.findIndex(arg => arg === '--category' || arg === '-c');
  if (categoryIndex !== -1 && args[categoryIndex + 1]) {
    options.category = args[categoryIndex + 1];
  }

  // Create validator and run all phases
  const validator = new RendererModularizationValidator();

  validator.loadSnapshot(); // Load previous run data
  validator.parseRenderer();
  validator.scanModules();
  validator.categorizeFunctions();
  validator.detectViolations();

  if (options.json) {
    console.log(JSON.stringify(validator.generateJSON(), null, 2));
  } else {
    validator.generateReport(options);
  }
  
  validator.saveSnapshot(); // Save current run data
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = RendererModularizationValidator;
