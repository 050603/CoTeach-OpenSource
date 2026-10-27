const test = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('@xmldom/xmldom');
const convert = require('./index');

const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

test('converts an OMML fraction without an HTML DOM shim', () => {
  const source = [
    `<m:oMath xmlns:m="${MATH_NS}">`,
    '<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num>',
    '<m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>',
    '</m:oMath>',
  ].join('');

  const document = new DOMParser().parseFromString(source, 'application/xml');
  const mathml = convert(document).toString();

  assert.match(mathml, /^<math /);
  assert.match(mathml, /<mfrac>/);
  assert.match(mathml, /<mn>1<\/mn>/);
  assert.match(mathml, /<mn>2<\/mn>/);
});
