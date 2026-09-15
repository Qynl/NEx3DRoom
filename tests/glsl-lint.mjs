/**
 * A small static analyser for the GLSL in this project.
 *
 * There is no GPU in CI, so instead of pretending the shaders are fine we parse
 * them and check the things that actually break at runtime:
 *   - the #version header is present and first
 *   - braces and parentheses balance
 *   - every varying written by the vertex stage is read by the fragment stage
 *     with a matching type
 *   - every identifier used in a shader is declared somewhere
 *     (this is what catches typos like `uModelTength`)
 *
 * Used by tests/frontend.test.mjs through the mock GL context.
 */

const TYPES = new Set([
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DShadow', 'samplerCubeShadow',
  'sampler2DArray', 'isampler2D', 'usampler2D',
]);

const BUILTINS = new Set([
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract', 'mod', 'modf',
  'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'isnan', 'isinf',
  'floatBitsToInt', 'intBitsToFloat', 'length', 'distance', 'dot', 'cross', 'normalize',
  'faceforward', 'reflect', 'refract', 'matrixCompMult', 'outerProduct', 'transpose',
  'determinant', 'inverse', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
  'equal', 'notEqual', 'any', 'all', 'not', 'textureSize', 'texture', 'textureProj',
  'textureLod', 'textureOffset', 'texelFetch', 'texelFetchOffset', 'textureProjLod',
  'dFdx', 'dFdy', 'fwidth', 'packSnorm2x16', 'unpackSnorm2x16',
  'gl_Position', 'gl_PointSize', 'gl_VertexID', 'gl_InstanceID', 'gl_FragCoord',
  'gl_FrontFacing', 'gl_FragDepth', 'gl_PointCoord', 'gl_PrimitiveID',
]);

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'switch',
  'case', 'default', 'struct', 'in', 'out', 'inout', 'uniform', 'const', 'precision',
  'highp', 'mediump', 'lowp', 'layout', 'flat', 'smooth', 'noperspective', 'centroid',
  'invariant', 'discard', 'true', 'false', 'attribute', 'varying', 'buffer', 'shared',
]);

const QUALIFIER_WORDS = new Set([
  'uniform', 'in', 'out', 'const', 'flat', 'smooth', 'centroid', 'highp', 'mediump',
  'lowp', 'layout', 'invariant', 'precision',
]);

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

export function lintGlsl(source, stage = 'fragment', label = 'shader') {
  const problems = [];
  const lines = source.split('\n');

  if (!lines[0].trim().startsWith('#version 300 es')) {
    problems.push(`${label}: missing '#version 300 es' header`);
  }

  let depth = 0, parens = 0;
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '(') parens++;
      else if (ch === ')') parens--;
    }
    if (depth < 0 || parens < 0) {
      problems.push(`${label}: unbalanced brackets on line ${i + 1}`);
      break;
    }
  }
  if (depth !== 0) problems.push(`${label}: ${depth} unclosed brace(s)`);
  if (parens !== 0) problems.push(`${label}: ${parens} unclosed paren(s)`);

  // Strip comments and preprocessor lines before analysing identifiers.
  const defines = new Set();
  const defineRe = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let match;
  while ((match = defineRe.exec(source)) !== null) defines.add(match[1]);

  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .replace(/layout\s*\([^)]*\)/g, ' ');

  const declared = new Set(defines);

  // Declarations: uniforms, varyings, constants and locals.
  const declRe = new RegExp(
    '(?:(?:uniform|in|out|inout|const|flat|smooth|centroid|noperspective|highp|mediump|lowp)\\s+)*' +
    `(${[...TYPES].join('|')})\\s+` +
    '([^;{}]*)\\s*;',
    'g'
  );
  while ((match = declRe.exec(code)) !== null) {
    for (const part of splitTopLevel(match[2])) {
      const head = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part);
      if (head && !TYPES.has(head[1])) declared.add(head[1]);
    }
  }

  // Function definitions and their parameters.
  const fnRe = new RegExp(
    `\\b(${[...TYPES].join('|')})\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(([^)]*)\\)\\s*\\{`,
    'g'
  );
  while ((match = fnRe.exec(code)) !== null) {
    declared.add(match[2]);
    for (const part of match[3].split(',')) {
      const bits = part.trim().split(/\s+/);
      const name = bits[bits.length - 1];
      if (name && !TYPES.has(name) && !QUALIFIER_WORDS.has(name)) declared.add(name);
    }
  }

  const used = new Set();
  const identRe = /(\.)?\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((match = identRe.exec(code)) !== null) {
    if (match[1] === '.') continue;              // swizzles / member access
    const name = match[2];
    if (KEYWORDS.has(name) || TYPES.has(name) || BUILTINS.has(name)) continue;
    used.add(name);
  }

  const undeclared = [...used].filter((name) => !declared.has(name));
  for (const name of undeclared) {
    problems.push(`${label}: '${name}' is used but never declared`);
  }

  return problems;
}

/** Parse `uniform <type> <name>[n];` into the active uniform list. */
export function parseUniforms(sources) {
  const uniforms = new Map();
  for (const source of sources) {
    if (!source) continue;
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const re = /uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z0-9_]+)\s+([A-Za-z_][A-Za-z0-9_]*)(\s*\[\s*(\d+)\s*\])?\s*(?:=\s*[^;]+)?;/g;
    let match;
    while ((match = re.exec(code)) !== null) {
      const [, type, name, , size] = match;
      uniforms.set(name, { type, size: size ? parseInt(size, 10) : 1 });
    }
  }
  return uniforms;
}

/** Parse `in`/`out` varyings so the two stages can be compared. */
export function parseVaryings(source) {
  const out = new Map();
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const re = /\b(in|out)\s+(?:flat\s+|smooth\s+|centroid\s+)?(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z0-9_]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    out.set(match[3], { direction: match[1], type: match[2] });
  }
  return out;
}
