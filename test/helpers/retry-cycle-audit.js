// Zero-dependency lexical audit used by the reset-credit re-arm structural
// guard. It tokenizes src/server.js (strings, template literals, comments and
// regex literals are skipped or kept opaque) and then ENUMERATES, at the token
// level with bracket-depth tracking:
//   - every reference to `forwardRequest` (definition, call, or anything else
//     such as an alias — the latter is a violation),
//   - the retry argument (6th) of every call, checked against an allowlist,
//   - every binding or write of `retryCount` (assignment incl. logical/bitwise
//     compound forms, ++/--, destructuring targets, for-in/of targets, let/
//     const/var and parameter shadowing), which must all sit inside the
//     `restartRetryCycle` helper except the single forwardRequest parameter.
// Text matching would let a parenthesised argument, an alias, or a
// destructuring reset slip through (Codex cross-model review, 2026-09-06).

// After these a `/` starts a regex literal rather than a division.
// Every entry is a reserved word in strict-mode module code (`yield` and
// `await` included), so an identifier can never spell one of them. `of` is
// NOT reserved — a `/` after it is ambiguous and the tokenizer fails closed.
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const CONTROL_FLOW_PAREN = new Set(['if', 'while', 'for', 'with']);
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];
export const ASSIGNMENT_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=',
  '^=', '&&=', '||=', '??=',
]);
const OPENERS = { '(': ')', '[': ']', '{': '}' };

function isIdentStart(ch) { return /[A-Za-z_$]/.test(ch); }
function isIdentPart(ch) { return /[\w$]/.test(ch); }

/** Tokenize JavaScript source; comments and whitespace are dropped. */
export function tokenizeJs(source) {
  const tokens = [];
  const templateStack = []; // brace depth at which each open `${` resumes its template
  const braceKinds = []; // 'object' | 'block' | 'template' for every open `{` / `${`
  let braceDepth = 0;
  let i = 0;
  let line = 1;
  const push = (type, value, start) => tokens.push({ type, value, start, end: i, line });
  // Does the previous token end an expression? Then a following `/` is a
  // division (and a following `++`/`--` is postfix), otherwise a regex.
  const endsExpression = prev => {
    if (!prev) return false;
    if (prev.type === 'num' || prev.type === 'str' || prev.type === 'tpl' || prev.type === 'regex') return true;
    if (prev.type === 'ident') return !REGEX_AFTER_KEYWORD.has(prev.value);
    if (prev.value === ')') return prev.controlFlow !== true; // `if (x) /re/` vs `(a) / b`
    if (prev.value === ']') return true;
    if (prev.value === '}') return prev.closes === 'object';
    if (prev.value === '++' || prev.value === '--') return prev.postfix === true;
    return false;
  };
  // A `/` is a regex start only where an expression cannot continue. Two
  // spots are ambiguous without a parser and FAIL CLOSED instead of guessing:
  // after a block/function-body `}` (statement-position regex vs a division
  // of a function expression) and after the non-reserved word `of`.
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (prev && prev.type === 'punct' && prev.value === '}' && prev.closes !== 'object') {
      throw new Error(`ambiguous "/" after "}" at line ${line} — wrap the regex in parentheses`);
    }
    const beforePrev = tokens[tokens.length - 2];
    const property = beforePrev && beforePrev.type === 'punct' && (beforePrev.value === '.' || beforePrev.value === '?.');
    if (prev && prev.type === 'ident' && prev.value === 'of' && !property) {
      throw new Error(`ambiguous "/" after "of" at line ${line} — wrap the operand in parentheses`);
    }
    if (prev && prev.type === 'ident' && property) return false; // `obj.return / 2` is a division
    return !endsExpression(prev);
  };
  const parenKinds = []; // true when the `(` follows if/while/for/with
  const braceKind = prev => {
    // `{` opens an object literal when it sits where an expression must
    // start; everywhere else (statement start, after `)`/`=>`/`;`/`}`/`{`,
    // after `else`/`do`/`try`/`finally`, class bodies) it opens a block.
    if (!prev) return 'block';
    if (prev.type === 'punct') {
      if (prev.value === '${') return 'object';
      if (prev.value === ':') {
        // `case x: {` / `default: {` / `label: {` open blocks; `k: {` and `c ? a : {` open objects.
        const a = tokens[tokens.length - 2];
        const b = tokens[tokens.length - 3];
        if (isIdent(a, 'default') || isIdent(b, 'case')) return 'block';
        if (isIdent(a) && (!b || (b.type === 'punct' && (b.value === ';' || b.value === '{' || b.value === '}')))) return 'block';
        return 'object';
      }
      return (prev.value === ')' || prev.value === ']' || prev.value === ';' || prev.value === '}'
        || prev.value === '{' || prev.value === '=>') ? 'block' : 'object';
    }
    if (prev.type === 'ident') return REGEX_AFTER_KEYWORD.has(prev.value) ? 'object' : 'block';
    return 'block';
  };
  const scanTemplate = () => {
    // called with i just past a "`" or a template-resuming "}"
    const start = i;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '\n') line++;
      if (ch === '`') { i++; push('tpl', source.slice(start, i), start); return; }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        push('tpl', source.slice(start, i), start);
        templateStack.push(braceDepth);
        braceKinds.push('template');
        braceDepth++;
        push('punct', '${', i - 2);
        return;
      }
      i++;
    }
    throw new Error('unterminated template literal');
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated block comment');
      line += (source.slice(i, end).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i++;
        if (source[i] === '\n') throw new Error(`unterminated string at line ${line}`);
        i++;
      }
      i++;
      push('str', source.slice(start, i), start);
      continue;
    }
    if (ch === '`') { i++; scanTemplate(); continue; }
    if (ch === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') throw new Error(`unterminated regex at line ${line}`);
        if (inClass) { if (c === ']') inClass = false; i++; continue; }
        if (c === '[') { inClass = true; i++; continue; }
        if (c === '/') { i++; break; }
        i++;
      }
      while (i < source.length && isIdentPart(source[i])) i++;
      push('regex', source.slice(start, i), start);
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i])) i++;
      push('ident', source.slice(start, i), start);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const start = i;
      i++;
      while (i < source.length && /[\w.]/.test(source[i])) i++;
      push('num', source.slice(start, i), start);
      continue;
    }
    const punct = PUNCTUATORS.find(p => source.startsWith(p, i));
    if (!punct) throw new Error(`unexpected character ${JSON.stringify(ch)} at line ${line}`);
    const start = i;
    i += punct.length;
    if (punct === '(') {
      const prev = tokens[tokens.length - 1];
      const beforePrev = tokens[tokens.length - 2];
      const property = beforePrev && beforePrev.type === 'punct' && (beforePrev.value === '.' || beforePrev.value === '?.');
      parenKinds.push(Boolean(prev && prev.type === 'ident' && CONTROL_FLOW_PAREN.has(prev.value) && !property));
    }
    if (punct === ')') {
      push('punct', punct, start);
      tokens[tokens.length - 1].controlFlow = parenKinds.pop() === true;
      continue;
    }
    if (punct === '{') {
      const kind = braceKind(tokens[tokens.length - 1]);
      braceKinds.push(kind);
      braceDepth++;
      push('punct', punct, start);
      tokens[tokens.length - 1].opens = kind;
      continue;
    }
    if (punct === '}') {
      braceDepth--;
      const closes = braceKinds.pop();
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        push('punct', '}', start);
        scanTemplate();
        continue;
      }
      push('punct', punct, start);
      tokens[tokens.length - 1].closes = closes;
      continue;
    }
    if (punct === '++' || punct === '--') {
      push('punct', punct, start);
      tokens[tokens.length - 1].postfix = endsExpression(tokens[tokens.length - 2]);
      continue;
    }
    push('punct', punct, start);
  }
  if (templateStack.length) throw new Error('unterminated template expression');
  return tokens;
}

function isPunct(token, value) { return Boolean(token) && token.type === 'punct' && token.value === value; }
function isIdent(token, value) { return Boolean(token) && token.type === 'ident' && (value === undefined || token.value === value); }

/** For each token index, the index of its matching bracket (both directions). */
function matchBrackets(tokens) {
  const match = new Array(tokens.length).fill(-1);
  const stack = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'punct') return;
    if (OPENERS[token.value] || token.value === '${') { stack.push(index); return; }
    if (token.value === ')' || token.value === ']' || token.value === '}') {
      const open = stack.pop();
      if (open === undefined) throw new Error(`unbalanced ${token.value} at line ${token.line}`);
      const expected = tokens[open].value === '${' ? '}' : OPENERS[tokens[open].value];
      if (expected !== token.value) throw new Error(`mismatched ${tokens[open].value}…${token.value} at line ${token.line}`);
      match[open] = index;
      match[index] = open;
    }
  });
  if (stack.length) throw new Error(`unbalanced ${tokens[stack[0]].value} at line ${tokens[stack[0]].line}`);
  return match;
}

/** Split the tokens strictly between open/close into top-level comma groups. */
function splitArgs(tokens, match, open) {
  const groups = [];
  let current = [];
  for (let k = open + 1; k < match[open]; k++) {
    const token = tokens[k];
    if (token.type === 'punct' && (OPENERS[token.value] || token.value === '${')) {
      current.push(...tokens.slice(k, match[k] + 1));
      k = match[k];
      continue;
    }
    if (isPunct(token, ',')) { groups.push(current); current = []; continue; }
    current.push(token);
  }
  if (current.length || groups.length) groups.push(current);
  return groups;
}

const argText = tokens => tokens.map(t => t.value).join(' ');

/**
 * Classify one `param` identifier token: 'read', 'write', 'binding', 'key'
 * (object property name / member access — not the variable), or 'param' (the
 * parameter of `fn` itself).
 */
/**
 * `(retryCount) = 1`, `((retryCount))++`, `[(retryCount)] = xs`: a grouping
 * whose only content is the identifier is transparent for assignment.
 * Returns [lo, hi] — the token range to classify as if it were the
 * identifier — after peeling such groupings (never a call, parameter list,
 * or control-flow parenthesis).
 */
function peelGroupings(tokens, match, index) {
  let lo = index;
  let hi = index;
  for (;;) {
    const open = tokens[lo - 1];
    const close = tokens[hi + 1];
    if (!isPunct(open, '(') || !isPunct(close, ')') || match[lo - 1] !== hi + 1) break;
    const beforeOpen = tokens[lo - 2];
    const afterClose = tokens[hi + 2];
    if (isPunct(afterClose, '=>') || isPunct(afterClose, '{')) break; // parameter list / control flow
    if (beforeOpen && beforeOpen.type === 'ident' && !REGEX_AFTER_KEYWORD.has(beforeOpen.value)) break; // call / catch / function / keyword head
    if (isPunct(beforeOpen, ']') || isPunct(beforeOpen, '*')) break; // call on a member / generator
    if (isPunct(beforeOpen, ')') && beforeOpen.controlFlow !== true) break; // call on a call result
    lo -= 1;
    hi += 1;
  }
  return [lo, hi];
}

/** Index of the innermost enclosing bracket opener of `index`, or -1. */
function innermostOpener(tokens, index) {
  let depth = 0;
  for (let k = index - 1; k >= 0; k--) {
    const token = tokens[k];
    if (token.type !== 'punct') continue;
    if (token.value === ')' || token.value === ']' || token.value === '}') { depth++; continue; }
    if (OPENERS[token.value] || token.value === '${') {
      if (depth > 0) { depth--; continue; }
      return k;
    }
  }
  return -1;
}

/**
 * Does the `{` at `k` open a class body? Walk backward over the heritage
 * expression (`class K extends mixin(Base, [x]) {`) at depth 0 until the
 * `class` keyword; any statement boundary or an unmatched opener means no.
 */
function isClassBodyOpener(tokens, match, k) {
  if (k < 0 || !isPunct(tokens[k], '{')) return false;
  for (let j = k - 1; j >= 0; j--) {
    const token = tokens[j];
    if (token.type === 'punct') {
      if (token.value === ')' || token.value === ']' || token.value === '}') { j = match[j]; continue; }
      if (OPENERS[token.value] || token.value === '${' || token.value === ';' || token.value === '=>' || token.value === ',') return false;
      continue;
    }
    if (isIdent(token, 'class')) return true;
    if (isIdent(token, 'function') || isIdent(token, 'catch') || CONTROL_FLOW_PAREN.has(token.value)
        || token.value === 'switch' || token.value === 'else' || token.value === 'try' || token.value === 'finally' || token.value === 'do') return false;
  }
  return false;
}

/** Is the innermost enclosing `{` of `index` a class body? */
function insideClassBody(tokens, match, index) {
  return isClassBodyOpener(tokens, match, innermostOpener(tokens, index));
}

/** Is token `index` directly inside an object literal or a class body (a member position)? */
function inMemberPosition(tokens, match, index) {
  const open = innermostOpener(tokens, index);
  if (open < 0 || !isPunct(tokens[open], '{')) return false;
  return tokens[open].opens === 'object' || isClassBodyOpener(tokens, match, open);
}

/** `let a, retryCount;` — a declarator list without an initializer. */
function inDeclaratorList(tokens, match, index) {
  let k = index - 1;
  while (k >= 0) {
    const token = tokens[k];
    if (token.type === 'punct') {
      if (token.value === ')' || token.value === ']' || token.value === '}') { k = match[k] - 1; continue; }
      if (OPENERS[token.value] || token.value === '${' || token.value === ';' || token.value === '=>') return false;
    }
    if (isIdent(token, 'let') || isIdent(token, 'const') || isIdent(token, 'var')) return true;
    k--;
  }
  return false;
}

function classifyParamToken(tokens, match, index, fn) {
  const [lo, hi] = peelGroupings(tokens, match, index);
  const prev = tokens[lo - 1];
  const next = tokens[hi + 1];
  if (isPunct(prev, '.') || isPunct(prev, '?.') || isPunct(prev, '#')) return 'key';
  if (isPunct(next, ':') && (isPunct(prev, '{') || isPunct(prev, ','))) return 'key';
  if (isPunct(prev, '[') && isPunct(next, ']') && isPunct(tokens[hi + 2], ':')
      && (isPunct(tokens[lo - 2], '{') || isPunct(tokens[lo - 2], ','))) return 'read'; // computed key `{ [retryCount]: x }`
  if (insideClassBody(tokens, match, lo)) return 'key'; // class field / method name
  if (isPunct(next, '++') || isPunct(next, '--') || isPunct(prev, '++') || isPunct(prev, '--')) return 'write';
  if (isIdent(prev, 'let') || isIdent(prev, 'const') || isIdent(prev, 'var')) return 'binding';
  if (isIdent(prev, 'function') || isIdent(prev, 'class')
      || (isPunct(prev, '*') && isIdent(tokens[lo - 2], 'function'))) return 'binding'; // declaration names
  if (isPunct(next, '=>')) return 'binding'; // `retryCount => …` (no parenthesis to walk)
  if (isIdent(next, 'of') || isIdent(next, 'in')) return 'write';
  if (isPunct(prev, ',') && inDeclaratorList(tokens, match, lo)) return 'binding'; // `let a, retryCount;`
  // The enclosing brackets decide BEFORE a trailing `=` is read as a write:
  // `(retryCount = 0) => …` is a parameter binding with a default, not a
  // write (Codex round on ec8b30f).
  const enclosure = classifyEnclosure(tokens, match, lo, fn);
  if (enclosure === 'binding' || enclosure === 'param' || enclosure === 'write') return enclosure;
  if (next && next.type === 'punct' && ASSIGNMENT_OPS.has(next.value)) return 'write';
  return 'read';
}

/**
 * Walk the enclosing brackets outward from `index`: destructuring targets,
 * declarations, and parameter lists bind or write the identifier; a call or
 * grouping makes it a plain read.
 */
/**
 * Inside the bracket pair opened at `open`, is token `index` in the binding
 * part of its comma-separated element (`target`, `target = default`,
 * `key: target = default`, `...rest`) or inside a default-value expression?
 */
function elementRole(tokens, match, open, index) {
  let start = open + 1;
  for (let k = open + 1; k < index; k++) {
    const token = tokens[k];
    if (token.type === 'punct' && (OPENERS[token.value] || token.value === '${')) { k = match[k]; continue; }
    if (isPunct(token, ',')) start = k + 1;
  }
  let sawColon = false;
  for (let k = start; k < index; k++) {
    const token = tokens[k];
    if (token.type === 'punct' && (OPENERS[token.value] || token.value === '${')) { k = match[k]; continue; }
    if (isPunct(token, ':') && tokens[open].value === '{') { sawColon = true; continue; }
    if (isPunct(token, '=')) return 'default';
  }
  void sawColon; // `key: target` — the target after the colon is still a binding
  return 'binding';
}

function classifyEnclosure(tokens, match, index, fn) {
  let k = index - 1;
  let depth = 0;
  while (k >= 0) {
    const token = tokens[k];
    if (token.type === 'punct') {
      if (token.value === ')' || token.value === ']' || token.value === '}') { depth++; k--; continue; }
      if (OPENERS[token.value] || token.value === '${') {
        if (depth > 0) { depth--; k--; continue; }
        const close = match[k];
        const afterClose = tokens[close + 1];
        const beforeOpen = tokens[k - 1];
        if (token.value === '${') return 'read';
        if (token.value === '{' || token.value === '[') {
          const isPattern = isPunct(afterClose, '=') || isIdent(afterClose, 'of') || isIdent(afterClose, 'in')
            || isIdent(beforeOpen, 'let') || isIdent(beforeOpen, 'const') || isIdent(beforeOpen, 'var');
          if (isPattern) {
            if (elementRole(tokens, match, k, index) === 'default') return 'read'; // `{ a = retryCount } = s`
            if (isIdent(beforeOpen, 'let') || isIdent(beforeOpen, 'const') || isIdent(beforeOpen, 'var')) return 'binding';
            return 'write'; // destructuring assignment or for ({…} of xs) target
          }
          k--; // nested pattern or object literal — keep walking outward
          continue;
        }
        // '('
        // `if (…) {` is control flow — unless the keyword is a property access
        // or a member name directly inside an object literal / class body.
        const controlFlowHead = isIdent(beforeOpen) && (CONTROL_FLOW_PAREN.has(beforeOpen.value) || beforeOpen.value === 'switch')
          && !isPunct(tokens[k - 2], '.') && !isPunct(tokens[k - 2], '?.') && !inMemberPosition(tokens, match, k - 1);
        const isParamList = isPunct(afterClose, '=>') || isIdent(beforeOpen, 'function') || isIdent(beforeOpen, 'catch')
          || (isIdent(beforeOpen) && isIdent(tokens[k - 2], 'function'))
          || (isPunct(afterClose, '{') && !controlFlowHead); // any method/function head: name, keyword, [computed], 'string', *, function*
        if (isParamList) {
          if (elementRole(tokens, match, k, index) === 'default') return 'read'; // `(x = retryCount) => x`
          if (isIdent(tokens[k - 2], 'function') && isIdent(beforeOpen, fn)) return 'param';
          return 'binding';
        }
        return 'read'; // call argument, grouping, or control-flow parenthesis
      }
    }
    k--;
  }
  return 'read';
}

/**
 * Audit `source` for the retry-cycle invariants. Returns { violations, calls,
 * writes, helper }; an empty `violations` array means every recursion and
 * every write is accounted for.
 */
export function auditRetryCycle(source, {
  fn = 'forwardRequest',
  param = 'retryCount',
  paramIndex = 5,
  helper = 'restartRetryCycle',
  allowedRetryArgs = ['0', `${'retryCount'} + 1`, 'retryCount'],
} = {}) {
  const tokens = tokenizeJs(source);
  const match = matchBrackets(tokens);
  const violations = [];
  const calls = [];
  const writes = [];
  const allowed = new Set(allowedRetryArgs.map(a => a.replace(/\s+/g, ' ')));

  // Dynamic code can write the parameter from a string the tokenizer keeps
  // opaque (`eval('retryCount = 7')` — a direct eval sees the enclosing
  // scope even in strict mode). Fail closed on any direct eval reference.
  tokens.forEach((token, index) => {
    if (isIdent(token, 'eval') && !isPunct(tokens[index - 1], '.') && !isPunct(tokens[index - 1], '?.')) {
      violations.push(`line ${token.line}: direct eval is not allowed in the audited source`);
    }
  });

  // The single definition and the position of the retry parameter.
  const defs = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => isIdent(token, fn) && isIdent(tokens[index - 1], 'function'));
  if (defs.length !== 1) violations.push(`expected exactly one function ${fn}, found ${defs.length}`);
  let paramTokenIndex = -1;
  if (defs.length === 1) {
    const open = defs[0].index + 1;
    const params = splitArgs(tokens, match, open);
    const retryParam = params[paramIndex] || [];
    if (retryParam.length !== 1 || !isIdent(retryParam[0], param)) {
      violations.push(`parameter ${paramIndex} of ${fn} is "${argText(retryParam)}", expected ${param}`);
    } else {
      paramTokenIndex = tokens.indexOf(retryParam[0]);
    }
  }

  // The helper body range.
  const helperDecl = tokens.findIndex((token, index) => isIdent(token, helper)
    && isIdent(tokens[index - 1], 'const') && isPunct(tokens[index + 1], '='));
  let helperRange = null;
  if (helperDecl < 0) {
    violations.push(`helper const ${helper} = … not found`);
  } else {
    const bodyOpen = tokens.findIndex((token, index) => index > helperDecl && isPunct(token, '{'));
    if (bodyOpen < 0 || !isPunct(tokens[bodyOpen - 1], '=>')) violations.push(`helper ${helper} must be an arrow function with a block body`);
    else helperRange = [bodyOpen, match[bodyOpen]];
  }

  // Every reference to fn.
  tokens.forEach((token, index) => {
    if (!isIdent(token, fn)) return;
    if (isIdent(tokens[index - 1], 'function')) return; // the definition
    if (isPunct(tokens[index - 1], '.')) return; // a property named like fn (hooks.forwardRequest) is not the function
    if (!isPunct(tokens[index + 1], '(')) {
      violations.push(`line ${token.line}: ${fn} referenced without being called (alias / value)`);
      return;
    }
    const args = splitArgs(tokens, match, index + 1);
    if (args.some(group => group.some(t => isPunct(t, '...')))) {
      violations.push(`line ${token.line}: ${fn}(…) uses a spread argument — positional retry argument is indeterminate`);
    }
    const retryArg = argText(args[paramIndex] || []);
    calls.push({ line: token.line, retryArg });
    if (!allowed.has(retryArg)) {
      violations.push(`line ${token.line}: ${fn}(…) retry argument "${retryArg}" is not allowlisted`);
    }
  });

  // Every binding / write of param.
  tokens.forEach((token, index) => {
    if (!isIdent(token, param) || index === paramTokenIndex) return;
    const kind = classifyParamToken(tokens, match, index, fn);
    if (kind === 'read' || kind === 'key') return;
    if (kind === 'param') { violations.push(`line ${token.line}: second ${fn} parameter named ${param}`); return; }
    if (kind === 'binding') { violations.push(`line ${token.line}: ${param} is re-bound (shadowing declaration / parameter / pattern)`); return; }
    const inHelper = helperRange && index > helperRange[0] && index < helperRange[1];
    writes.push({ line: token.line, inHelper, text: argText(tokens.slice(index, index + 3)) });
    if (!inHelper) violations.push(`line ${token.line}: ${param} written outside ${helper}(): ${argText(tokens.slice(index - 1, index + 4))}`);
  });
  if (helperRange) {
    const helperWrites = writes.filter(w => w.inHelper);
    if (helperWrites.length !== 1 || helperWrites[0].text !== `${param} = 0`) {
      violations.push(`${helper}() must contain exactly one write "${param} = 0", found: ${helperWrites.map(w => w.text).join(' | ') || 'none'}`);
    }
  }
  return { violations, calls, writes, helperRange, tokens };
}
