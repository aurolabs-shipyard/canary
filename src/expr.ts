// Tiny safe expression evaluator. Used to evaluate operator-authored rule
// expressions from canary.yaml against a fixed context object. Supports:
//   literals: numbers, true/false, null
//   identifiers (context lookups, dotted paths not supported)
//   comparisons: == != < > <= >=
//   logical: && || !
//   arithmetic: + - * /
//   parentheses
// Anything outside this grammar is a parse error — no calls, no member access.

type Tok =
  | { k: "num"; v: number }
  | { k: "ident"; v: string }
  | { k: "op"; v: string }
  | { k: "lparen" }
  | { k: "rparen" }
  | { k: "end" };

const MULTI_CHAR_OPS = ["==", "!=", "<=", ">=", "&&", "||"];
const SINGLE_CHAR_OPS = "+-*/<>!";

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ k: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ k: "rparen" });
      i++;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ k: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ k: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_OPS.includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`expr: unexpected '${c}' at ${i}`);
  }
  out.push({ k: "end" });
  return out;
}

type Node =
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "ident"; v: string }
  | { t: "unary"; op: string; rhs: Node }
  | { t: "binary"; op: string; lhs: Node; rhs: Node };

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
};

function parse(toks: Tok[]): Node {
  let pos = 0;
  const peek = () => toks[pos];
  const eat = () => toks[pos++];

  function parsePrimary(): Node {
    const t = eat();
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.k === "ident") {
      if (t.v === "true") return { t: "bool", v: true };
      if (t.v === "false") return { t: "bool", v: false };
      if (t.v === "null") return { t: "null" };
      return { t: "ident", v: t.v };
    }
    if (t.k === "lparen") {
      const inner = parseBinary(0);
      const close = eat();
      if (close.k !== "rparen") throw new Error("expr: expected )");
      return inner;
    }
    if (t.k === "op" && (t.v === "!" || t.v === "-")) {
      return { t: "unary", op: t.v, rhs: parsePrimary() };
    }
    throw new Error(`expr: unexpected token ${JSON.stringify(t)}`);
  }

  function parseBinary(minPrec: number): Node {
    let lhs = parsePrimary();
    while (true) {
      const t = peek();
      if (t.k !== "op") break;
      const prec = PRECEDENCE[t.v];
      if (prec == null || prec < minPrec) break;
      eat();
      const rhs = parseBinary(prec + 1);
      lhs = { t: "binary", op: t.v, lhs, rhs };
    }
    return lhs;
  }

  const root = parseBinary(0);
  if (peek().k !== "end") throw new Error("expr: trailing tokens");
  return root;
}

function evalNode(node: Node, ctx: Record<string, unknown>): unknown {
  switch (node.t) {
    case "num":
      return node.v;
    case "bool":
      return node.v;
    case "null":
      return null;
    case "ident":
      return ctx[node.v];
    case "unary": {
      const r = evalNode(node.rhs, ctx);
      if (node.op === "!") return !truthy(r);
      if (node.op === "-") return -(num(r));
      throw new Error(`expr: unknown unary ${node.op}`);
    }
    case "binary": {
      if (node.op === "&&") return truthy(evalNode(node.lhs, ctx)) && truthy(evalNode(node.rhs, ctx));
      if (node.op === "||") return truthy(evalNode(node.lhs, ctx)) || truthy(evalNode(node.rhs, ctx));
      const l = evalNode(node.lhs, ctx);
      const r = evalNode(node.rhs, ctx);
      switch (node.op) {
        case "==":
          return l === r;
        case "!=":
          return l !== r;
        case "<":
          return cmp(l, r) < 0;
        case ">":
          return cmp(l, r) > 0;
        case "<=":
          return cmp(l, r) <= 0;
        case ">=":
          return cmp(l, r) >= 0;
        case "+":
          return num(l) + num(r);
        case "-":
          return num(l) - num(r);
        case "*":
          return num(l) * num(r);
        case "/":
          return num(l) / num(r);
        default:
          throw new Error(`expr: unknown op ${node.op}`);
      }
    }
  }
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  return Boolean(v);
}

function num(v: unknown): number {
  if (v === null || v === undefined) return Number.NaN;
  return Number(v);
}

function cmp(a: unknown, b: unknown): number {
  if (a === null || b === null || a === undefined || b === undefined) return Number.NaN;
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) {
    if (an === bn) return 0;
    return an < bn ? -1 : 1;
  }
  return String(a).localeCompare(String(b));
}

const cache = new Map<string, Node>();

export function compileExpr(src: string): (ctx: Record<string, unknown>) => unknown {
  let ast = cache.get(src);
  if (!ast) {
    ast = parse(tokenize(src));
    cache.set(src, ast);
  }
  return (ctx) => evalNode(ast!, ctx);
}
