"use strict";

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var path = require('path');

var parser = require('acorn-jsx');
var walk = require('acorn/dist/walk');
var gettextParser = require('gettext-parser');
var regExpEscape  = require('escape-string-regexp');

var poHelper = require('./po-helper');

var defaultParserOptions = {
  ecmaVersion: 6,
  sourceType: 'module',
  plugins: { jsx: { allowNamespaces: false } },
  locations: true
};

var walkBase = Object.assign({}, walk.base, {
  JSXElement: function (node, st, c) {
    var i;

    for (i = 0; i < node.openingElement.attributes.length; i++) {
      c(node.openingElement.attributes[i], st);
    }

    for (i = 0; i < node.children.length; i++) {
      c(node.children[i], st);
    }
  },

  JSXAttribute: function (node, st, c) {
    if (node.value.type === 'JSXExpressionContainer') {
      c(node.value, st);
    }
  },

  JSXSpreadAttribute: function (node, st, c) {
    c(node.argument, st);
  },

  JSXExpressionContainer: function (node, st, c) {
    c(node.expression, st);
  },

  JSXEmptyExpression: function () {}
});

function isStringLiteral(node) {
  return node.type === 'Literal' && (typeof node.value === 'string');
}

function isStrConcatExpr(node) {
  var left = node.left;
  var right = node.right;

  return node.type === "BinaryExpression" && node.operator === '+' && (
      (isStringLiteral(left) || isStrConcatExpr(left)) &&
      (isStringLiteral(right) || isStrConcatExpr(right))
  );
}

function isString(node) {
  return isStringLiteral(node) || isStrConcatExpr(node);
}

// finds comments that end on the previous line
function findComments(comments, line) {
  return comments.map(function (node) {
    var commentLine = node.line.line;
    if (commentLine === line || commentLine + 1 === line) {
      return node.value;
    }
  }).filter(Boolean).join('\n');
}

// Assumes node is either a string Literal or a strConcatExpression
function extractStr(node) {
  if (isStringLiteral(node))
    return node.value;
  else
    return extractStr(node.left) + extractStr(node.right);
}

function getFunctionNameAndArguments(node) {
  // must be a call expression with arguments
  if (!node.arguments)
    return false;

  var callee = node.callee;
  var funcName = callee.name;
  var args = node.arguments;

  if (!funcName) {
    if (callee.type !== 'MemberExpression')
      return false;

    // Special case for functionName.call calls
    if (callee.property.name === 'call') {
      var prop = callee.object.property;
      funcName = callee.object.name || prop && (prop.name || prop.value);
      args = node.arguments.slice( 1 );  // skip context object
    } else {
      funcName = callee.property.name;
    }
  }

  return [funcName, args];
}

function maybeExtractMsgids(node, allowedNames, strict) {
  var a = getFunctionNameAndArguments(node);
  if (!a) {
    return false;
  }
  var functionName = a[0];
  var args = a[1];
  var firstArg = args[0];
  var secondArg = args[1];

  if (allowedNames.indexOf(functionName) === -1)
    return false;

  // If the gettext function's name starts with "n" (i.e. ngettext or n_) and its first 2 arguments are strings, we regard it as a plural function
  if (firstArg && functionName.substr(0, 1) === "n" && isString(firstArg) && secondArg && isString(secondArg)) {
    return [extractStr(firstArg), extractStr(secondArg)];
  } else if (firstArg && isString(firstArg)) {
    return [extractStr(firstArg)];
  } else if (strict) {
    throw new Error("Could not parse translatable: " + JSON.stringify(firstArg, null, 2));
  }
}

function parseFile(filename, source, commentRegex, functionNames, strict) {
  source = source.replace(/^#.*/, ''); // strip leading hash-bang
  var astComments = [], translations = {};
  var ast      = parser.parse(source, Object.assign({}, defaultParserOptions, {
    onComment: function (block, text, start, end, line/*, column*/) {
      text = text.match(commentRegex) && text.replace(/^\//, '').trim();

      if (!text)
        return;

      astComments.push({
        line : line,
        value: text
      });
    },
  }));


  walk.simple(ast, {'CallExpression': function (node) {
    var msgids = maybeExtractMsgids(node, functionNames, strict);
    if (!msgids)
      return;

    var msgid = msgids[0];
    var line = node.loc.start.line;
    var comments = findComments(astComments, line);
    var ref = filename + ':' + line;

    var translation = {
      msgid: msgid,
      msgstr: [],
      comments: {
        extracted: comments,
        reference: ref
      }
    };
    if( msgids.length > 1 ) {
      translation.msgid_plural = msgids[1];
      translation.msgstr = ['', ''];
    }

    if (msgid in translations) {
      translations[msgid] = poHelper.mergeTranslation(translations[msgid], translation);
    } else {
      translations[msgid] = translation;
    }
  }
  }, walkBase);

  return translations;
}

function parse(sources, options) {
  var useExisting = options.joinExisting;
  var poJSON;
  if (useExisting)
    poJSON = poHelper.readPoFile(path.resolve(path.join(options.outputDir || '', options.output)));

  if (!poJSON) {
    poJSON = {
      charset: "utf-8",
      headers: poHelper.defaultHeaders(options.projectIdVersion, options.reportBugsTo),
      translations: {'': {} }
    };
  }

  if (!(poJSON.translations && typeof poJSON.translations === 'object')) {
      throw new Error("An error occurred while using the provided PO file. Please make sure it is valid by using `msgfmt -c`.");
  }

  // Duplicate translations so that we can compare new translations to the existing ones
  var translations = JSON.parse(JSON.stringify(poJSON.translations['']));

  if( options.keyword ) {
    Object.keys(options.keyword).forEach(function (index) {
      options.keyword.push('n' + options.keyword[index]);
    });
  }
  else {
    options.keyword = ['gettext', 'ngettext'];
  }
  var tagName = options.addComments || "L10n:";
  var commentRegex = new RegExp([
    "^\\s*" + regExpEscape(tagName), // The "TAG" provided externally or "L10n:" by default
    "^\\/" // The "///" style comments which is the xgettext standard
  ].join("|"));
  Object.keys(sources).forEach(function(filename) {
    var source = sources[filename];
    var newTranslations = parseFile(filename, source, commentRegex, options.keyword, options.sanity);
    translations = poHelper.mergeTranslations(translations, newTranslations);
  });

  if (useExisting && poHelper.compareTranslations(translations, poJSON.translations[''])) {
    // Only update the creation date if the content changed
    poJSON.headers["pot-creation-date"] = new Date().toISOString().replace('T', ' ').replace(/:\d{2}.\d{3}Z/, '+0000');
  }
  poJSON.translations[''] = translations;

  return poJSON;
}
exports.parse = parse;


// generate extracted strings file
function gen(sources, options) {
  return gettextParser.po.compile(parse(sources, options)).toString();
}

exports.generate = gen;

// Backwards compatibility interface for 0.3.x - Deprecated!
var parsers = require('./parsers');

Object.keys(parsers).forEach(function (parser) {
  parser = parsers[parser];
  exports['generateFrom' + parser.name] = parser;
});
