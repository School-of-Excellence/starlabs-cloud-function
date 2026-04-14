const fs = require('fs');
const path = require('path');

// Remove comments from code
function removeComments(code) {
  code = code.replace(/\/\/.*$/gm, '');
  code = code.replace(/\/\*[\s\S]*?\*\//g, '');
  return code;
}

// Parse index.js once to get both requires and exports
function parseIndexFile(indexPath) {
  
  let content = fs.readFileSync(indexPath, 'utf8');
  const rawLength = content.length;
  content = removeComments(content);
  
  // Get require statements
  const requires = {};
  const requireRegex = /const\s+(\w+)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  
  while ((match = requireRegex.exec(content)) !== null) {
    requires[match[1]] = match[2];
  }
  
  // Get exported functions
  const functions = [];
  const exportRegex = /exports\.(\w+)\s*=\s*(\w+)\.(\w+)/g;
  
  while ((match = exportRegex.exec(content)) !== null) {
    functions.push({
      exportName: match[1],
      moduleName: match[2],
      functionName: match[3]
    });
  }
  
  return { requires, functions };
}

// Read all unique component files once and store in map
function readComponentFiles(requires, indexDir) {
  
  const filesContent = {};
  const uniquePaths = new Set(Object.values(requires));
  
  uniquePaths.forEach(requirePath => {
    const filePath = path.resolve(indexDir, requirePath + '.js');
    
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      content = removeComments(content);
      filesContent[requirePath] = {
        path: filePath,
        content: content,
        size: content.length
      };
    } else {
      filesContent[requirePath] = null;
    }
  });
  
  return filesContent;
}

// Find function type in already-read file content
function getFunctionType(fileData, functionName) {
  if (!fileData) {
    return { type: 'FILE_NOT_FOUND', found: false };
  }
  
  const content = fileData.content;
  
  // Search for the function name
  const searchPatterns = [
    `exports.${functionName}`,
    `const ${functionName}`,
    `module.exports.${functionName}`,
    `${functionName} =`,
    `${functionName}:`
  ];
  
  let functionBody = '';
  let foundPattern = null;
  
  for (const pattern of searchPatterns) {
    const index = content.indexOf(pattern);
    if (index !== -1) {
      functionBody = content.substring(index, index + 2000);
      foundPattern = pattern;
      break;
    }
  }
  
  if (!functionBody) {
    return { type: 'NOT_FOUND', found: false, searched: searchPatterns };
  }
  
  // Detect type
  if (functionBody.match(/onRequest|https\.onRequest/)) {
    return { type: 'onRequest', found: true };
  }
  if (functionBody.match(/onCall|https\.onCall/)) {
    return { type: 'onCall', found: true };
  }
  if (functionBody.match(/onSchedule|pubsub\.schedule|schedule\(/)) {
    return { type: 'onSchedule', found: true };
  }
  if (functionBody.match(/onMessagePublished|pubsub\.topic/)) {
    return { type: 'onMessagePublished', found: true };
  }
  if (functionBody.match(/onDocumentCreated|\.onCreate\(/)) {
    return { type: 'onDocumentCreated', found: true };
  }
  if (functionBody.match(/onDocumentUpdated|\.onUpdate\(/)) {
    return { type: 'onDocumentUpdated', found: true };
  }
  if (functionBody.match(/onDocumentWritten|\.onWrite\(/)) {
    return { type: 'onDocumentWritten', found: true };
  }
  if (functionBody.match(/onDocumentDeleted|\.onDelete\(/)) {
    return { type: 'onDocumentDeleted', found: true };
  }
  
  return { type: 'UNKNOWN', found: true, snippet: functionBody.substring(0, 100) };
}

// Check for self-triggering issues in Firestore functions
function checkCodeQuality(fileData, functionName, triggerType) {

  const result = {
    status: "Passed",
    issues: []
  };

  if (!fileData?.content) return result;

  const content = fileData.content;
  const lines = content.split("\n");

  // Locate function
  const patterns = [
    `exports.${functionName}`,
    `const ${functionName}`,
    `module.exports.${functionName}`
  ];

  let start = -1;
  for (const p of patterns) {
    start = content.indexOf(p);
    if (start !== -1) break;
  }

  if (start === -1) return result;

  const functionCode = content.substring(start, start + 5000);

  // Only Firestore triggers
  if (!["onDocumentUpdated","onDocumentWritten"].includes(triggerType)) {
    return result;
  }

  // Detect trigger collection
  const pathMatch = functionCode.match(/["']([^"']+)\/\{[^}]+\}["']/);
  if (!pathMatch) return result;

  const triggerCollection = pathMatch[1];

  // Write detection
  const writeRegex = /\.(set|update)\s*\(/g;

  let match;

  while ((match = writeRegex.exec(functionCode)) !== null) {

    const absoluteIndex = start + match.index;

    const lineNumber = content.substring(0, absoluteIndex).split("\n").length;
    const lineText = lines[lineNumber - 1]?.trim();

    const contextBefore = functionCode.substring(Math.max(0, match.index - 200), match.index);

    // Detect write collection
    let writesToTrigger = false;

    if (contextBefore.includes("change.after.ref") || contextBefore.includes("changedata.data.after.ref")) {
      writesToTrigger = true;
    }

    const collectionMatch = contextBefore.match(/collection\s*\(\s*["']([^"']+)["']\s*\)/);

    if (collectionMatch && collectionMatch[1] === triggerCollection) {
      writesToTrigger = true;
    }

    if (!writesToTrigger) continue;

    // Check if inside IF block
    const codeBefore = functionCode.substring(0, match.index);

    const lastIf = codeBefore.lastIndexOf("if(");
    const lastBraceClose = codeBefore.lastIndexOf("}");

    const insideIfBlock = lastIf !== -1 && lastIf > lastBraceClose;

    if (!insideIfBlock) {
      result.issues.push({
        type: "SelfTrigger",
        line: lineNumber,
        code: lineText,
        message: "Write to triggered collection without condition guard"
      });
    }

  }

  if (result.issues.length > 0) {
    result.status = "Failed";
  }

  return result;
}

// Main
function main() {
  const indexPath = './index.js';
  const indexDir = path.dirname(path.resolve(indexPath));
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('Firebase Functions Analyzer');
  console.log(`${'='.repeat(60)}\n`);
  
  // Step 1: Parse index.js once
  const { requires, functions } = parseIndexFile(indexPath);
  
  console.log(`📋 Found ${functions.length} exported functions`);
  console.log(`📦 Found ${Object.keys(requires).length} module imports\n`);
  
  // Step 2: Read all component files once
  const filesContent = readComponentFiles(requires, indexDir);
  
  const filesRead = Object.values(filesContent).filter(f => f !== null).length;
  console.log(`📁 Read ${filesRead} component files\n`);
  
  // Step 3: Analyze each function using pre-read content
  const results = {};
  const details = [];
  
  functions.forEach(func => {
    const requirePath = requires[func.moduleName];
    
    if (!requirePath) {
      const type = 'MODULE_NOT_FOUND';
      if (!results[type]) results[type] = [];
      results[type].push(func.exportName);
      details.push({
        exportName: func.exportName,
        moduleName: func.moduleName,
        type: type,
        issue: `Module '${func.moduleName}' not found in requires`
      });
      return;
    }
    
    const fileData = filesContent[requirePath];
    const analysis = getFunctionType(fileData, func.functionName);

    // Debug - Self Trigger
    const codeQuality = checkCodeQuality(fileData, func.functionName, analysis.type);
    
    if (!results[analysis.type]) results[analysis.type] = [];
    results[analysis.type].push(`${func.exportName} - ${func.moduleName}: "${requirePath}"`);
    
    details.push({
      exportName: func.exportName,
      moduleName: func.moduleName,
      functionName: func.functionName,
      filePath: fileData ? fileData.path : 'N/A',
      type: analysis.type,
      found: analysis.found,
      snippet: analysis.snippet,
      searched: analysis.searched,
      codeQuality: codeQuality
    });
  });
  
  // Display results
  console.log('📊 Analysis Results:\n');
  console.log(`${'─'.repeat(60)}\n`);
  
  Object.keys(results).sort().forEach(type => {
    const icon = type.includes('NOT_FOUND') || type === 'UNKNOWN' ? '⚠️ ' : '✓ ';
    console.log(`${icon}${type} (${results[type].length}):`);
    results[type].forEach(name => console.log(`  - ${name}`));
    console.log();
  });
  
  // Summary statistics
  const total = functions.length;
  const identified = details.filter(d => d.found && d.type !== 'UNKNOWN').length;
  const unknown = results['UNKNOWN'] ? results['UNKNOWN'].length : 0;
  const notFound = details.filter(d => !d.found).length;
  
  console.log(`${'─'.repeat(60)}\n`);
  console.log('📈 Statistics:');
  console.log(`   Total functions: ${total}`);
  console.log(`   ✓ Identified: ${identified}`);
  console.log(`   ⚠️  Unknown: ${unknown}`);
  console.log(`   ✗ Not found: ${notFound}`);
	console.log()

  // Code Quality Summary
	console.log(`${'─'.repeat(60)}\n`);
	console.log('🔍 Code Quality Analysis:\n');

	const qualityStats = {
		passed: 0,
		warning: 0,
		failed: 0,
		total: 0
	};

	const issueCount = {};

	details.forEach(d => {
		if (d.codeQuality && d.codeQuality.status) {
			qualityStats.total++;
			if (d.codeQuality.status === 'Passed') qualityStats.passed++;
			else if (d.codeQuality.status === 'Warning') qualityStats.warning++;
			else if (d.codeQuality.status === 'Failed') qualityStats.failed++;

			// Count issues
			d.codeQuality.issues.forEach(issue => {
				issueCount[issue] = (issueCount[issue] || 0) + 1;
			});
		}
	});

	console.log(`   Functions Analyzed: ${qualityStats.total}`);
	console.log(`   ✓ Passed: ${qualityStats.passed}`);
	console.log(`   ⚠️  Warning: ${qualityStats.warning}`);
	console.log(`   ❌ Failed: ${qualityStats.failed}`);
	console.log();

	// Issue breakdown
	if (Object.keys(issueCount).length > 0) {
		console.log('   Issues Found:');
		Object.entries(issueCount).sort((a, b) => b[1] - a[1]).forEach(([issue, count]) => {
			console.log(`      ${issue}: ${count}`);
		});
		console.log();
	}

	// Failed functions
	const failedFunctions = details.filter(d => d.codeQuality?.status === 'Failed');
	if (failedFunctions.length > 0) {
		console.log(`❌ Failed Functions (${failedFunctions.length}):\n`);
		failedFunctions.forEach((d, index) => {
			console.log(`Function ${index+1} --- ${d.exportName} ${d.codeQuality.issues.map(e => {
        return `\n⚠️  ${e["message"]}: ${e["code"]}`
      }).join(', ')}`);
      console.log()
		});
		console.log();
	}

	// Warning functions
	const warningFunctions = details.filter(d => d.codeQuality?.status === 'Warning');
	if (warningFunctions.length > 0) {
		console.log(`⚠️  Warning Functions (${warningFunctions.length}):\n`);
		warningFunctions.forEach(d => {
			console.log(`   ${d.exportName}: [${d.codeQuality.issues.join(', ')}]`);
		});
		console.log();
	}

	console.log(`${'*'.repeat(10)} THE END ${'*'.repeat(10)}`);
}

// Run
try {
  main();
} catch (error) {
  console.error('\n❌ Error:', error.message);
  // process.exit(1);
}