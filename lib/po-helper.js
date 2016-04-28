'use strict';

var fs   = require('fs');
var path = require('path');
var gettextParser = require('gettext-parser');

function deduplicateFilter(item, i, arr) {
  return item && arr.indexOf(item) === i;
}

function mergeComment(oldComment, newComment) {
  if (typeof oldComment === 'string' && typeof newComment === 'string') {
    return oldComment.split('\n')
                      .concat(newComment.split('\n'))
                      .filter(deduplicateFilter)
                      .join('\n');
  }
  return oldComment || newComment;
}

function mergeComments(oldComments, newComments) {
  if (typeof oldComments === 'object' && typeof newComments === 'object') {
    return {
      reference: mergeComment(oldComments.reference, newComments.reference),
      extracted: mergeComment(oldComments.extracted, newComments.extracted)
    };
  }
  return oldComments || newComments;
}

function mergeTranslation(oldTranslation, newTranslation) {
  var translation = Object.assign({ comments: {} }, oldTranslation, newTranslation);
  translation.comments= mergeComments(oldTranslation.comments, newTranslation.comments);
  return translation;
}

exports.mergeTranslations = function(oldTranslations, newTranslations) {
  //console.log("Merging translations", oldTranslations, newTranslations);
  var translations = JSON.parse(JSON.stringify(oldTranslations));
  for (var msgId in newTranslations) {
    if (msgId in translations) {
      translations[msgId] = mergeTranslation(translations[msgId], newTranslations[msgId]);
    } else {
      translations[msgId] = newTranslations[msgId];
    }
  }
  return translations;
};

exports.readPoFile = function(filePath) {
  try {
    return gettextParser.po.parse(fs.readFileSync(path.resolve(filePath)), "utf-8");
  } catch (e) {
    return null;
  }
};

exports.defaultHeaders = function(projectIdVersion, reportBugsTo) {
  return {
      "project-id-version": projectIdVersion || "PACKAGE VERSION",
      "language-team": "LANGUAGE <LL@li.org>",
      "report-msgid-bugs-to": reportBugsTo,
      "pot-creation-date": new Date().toISOString().replace('T', ' ').replace(/:\d{2}.\d{3}Z/, '+0000'),
      "po-revision-date": "YEAR-MO-DA HO:MI+ZONE",
      "language": "",
      "mime-version": "1.0",
      "content-type": "text/plain; charset=utf-8",
      "content-transfer-encoding": "8bit"
    };
};
