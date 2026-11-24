// Lane L5 (domain / legacy packs): behaviour that the generic contract suite does not pin down.
// Run: node --test plugins/codegraph/tests/languages/l5-*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, extractFile, loadSpecs, specForPath } from '../../src/extract/engine.mjs';

let specs;
try {
  await initEngine();
  specs = await loadSpecs();
} catch (err) {
  test('language packs load', () => {
    throw err;
  });
  specs = [];
}
const byId = new Map(specs.map((s) => [s.id, s]));
const extract = (id, path, source) => extractFile({ path, source, spec: byId.get(id) });
const sym = (out, name) => out.symbols.find((s) => s.name === name);

test('extension ownership: cfml vs cfscript vs cobol', () => {
  assert.equal(specForPath('a.cfc', specs)?.id, 'cfml');
  assert.equal(specForPath('a.cfm', specs)?.id, 'cfml');
  assert.equal(specForPath('a.CFS', specs)?.id, 'cfscript');
  assert.equal(specForPath('a.tfvars', specs)?.id, 'terraform');
  assert.equal(specForPath('a.tofu', specs)?.id, 'terraform');
  assert.equal(specForPath('a.lpr', specs)?.id, 'pascal');
  assert.equal(specForPath('a.app.src', specs)?.id, 'erlang');
  assert.equal(specForPath('a.cpy', specs)?.id, 'cobol');
});

test('terraform: block naming, kinds, module source import and reference chains', async () => {
  const out = await extract('terraform', 'main.tf', `# Stack.
provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

locals {
  name = "\${var.project}-\${var.env}"
}

module "network" {
  source = "./modules/network"
}

resource "aws_instance" "web" {
  ami       = data.aws_ami.ubuntu.id
  subnet_id = module.network.subnet_id
  count     = length(var.azs) > 0 ? 1 : 0
}

output "id" {
  value = aws_instance.web.id
}
`);
  assert.equal(out.parseOk, true);
  assert.deepEqual(
    out.symbols.map((s) => [s.kind, s.name]),
    [
      ['other', 'provider.aws'],
      ['variable', 'variable.region'],
      ['other', 'locals'],
      ['variable', 'name'],
      ['module', 'module.network'],
      ['component', 'resource.aws_instance.web'],
      ['constant', 'output.id'],
    ],
  );
  assert.equal(sym(out, 'provider.aws').doc, 'Stack.');
  assert.equal(sym(out, 'variable.region').doc, null, 'a comment before the first block is not a doc for every block');
  assert.deepEqual(out.imports.map((i) => [i.kind, i.spec]), [['module', './modules/network']]);
  assert.equal(out.refs.filter((r) => r.kind === 'call').length, 0, 'HCL has no calls');
  // Pure reference chains only: `type = string` and the function call inside `count` are not refs.
  assert.deepEqual(out.refs.map((r) => r.name), [
    'var.region',
    'var.project',
    'var.env',
    'data.aws_ami.ubuntu.id',
    'module.network.subnet_id',
    'var.azs',
    'aws_instance.web.id',
  ]);
  assert.equal(out.refs.find((r) => r.name === 'module.network.subnet_id').symbol, out.symbols.indexOf(sym(out, 'resource.aws_instance.web')));
});

test('nix: binding kinds, receiver split, argument attrsets skipped, import as import', async () => {
  const out = await extract('nix', 'flake.nix', `{ pkgs, ... }:

let
  version = "1.0";
  greet = name: "hi \${name}";
  mkPackage = { name, version ? "0", src }: pkgs.stdenv.mkDerivation {
    inherit name version src;
    buildInputs = [ pkgs.hello ];
  };
  packages = { hello = pkgs.hello; };
  cfg = import ./config.nix;
  nixpkgs = import <nixpkgs> { };
  lib = with pkgs.lib; optionalString true "x";
in
{
  body = greet "world";
  inherit (pkgs) lib;
}
`);
  assert.equal(out.parseOk, true, 'fixture must parse');
  assert.deepEqual(
    out.symbols.map((s) => [s.kind, s.name]),
    [
      ['variable', 'version'],
      ['function', 'greet'],
      ['function', 'mkPackage'],
      ['type', 'packages'],
      ['variable', 'hello'],
      ['variable', 'cfg'],
      ['variable', 'nixpkgs'],
      ['variable', 'lib'],
      ['variable', 'body'],
    ],
  );
  assert.deepEqual(
    out.imports.map((i) => [i.kind, i.spec]),
    [
      ['import', './config.nix'],
      ['import', '<nixpkgs>'],
    ],
  );
  // Curried application `optionalString true "x"` is one call named after its head.
  assert.deepEqual(
    out.refs.filter((r) => r.kind === 'call').map((r) => [r.name, r.receiver]),
    [
      ['mkDerivation', 'pkgs.stdenv'],
      ['optionalString', ''],
      ['greet', ''],
    ],
  );
  // Attrpath identifiers (`buildInputs`, `inherit name version src`) and formal names are not refs;
  // the `${name}` use inside the string still is.
  assert.ok(!out.refs.some((r) => r.name === 'buildInputs' || r.name === 'version' || r.name === 'src'));
  assert.deepEqual(
    out.refs.filter((r) => r.name === 'name').map((r) => r.startLine),
    [5],
  );
});

test('erlang: multi-clause functions merge, exports and remote calls', async () => {
  const out = await extract('erlang', 'vault.erl', `-module(vault).
-export([deposit/2, balance/1]).
-import(lists, [sum/1]).
-include("vault.hrl").
-record(account, {owner, balance = 0}).

%% @doc Credits an amount.
deposit(Owner, Amount) when Amount > 0 ->
    gen_server:call(?MODULE, {deposit, Owner, Amount});
deposit(_Owner, _Amount) ->
    {error, badarg}.

balance(Owner) ->
    lists:sum([1, 2]).

hidden(X) ->
    X.
`);
  assert.equal(out.parseOk, true);
  const deposit = sym(out, 'deposit');
  assert.deepEqual([deposit.startLine, deposit.endLine], [8, 11], 'deposit/2 spans both clauses');
  assert.equal(out.symbols.filter((s) => s.name === 'deposit').length, 1);
  assert.equal(deposit.doc, 'Credits an amount.');
  assert.equal(deposit.exported, true);
  assert.equal(sym(out, 'hidden').exported, false);
  assert.deepEqual([sym(out, 'account').kind, sym(out, 'balance').kind], ['struct', 'field']);
  assert.deepEqual(
    out.imports.map((i) => [i.kind, i.spec]),
    [
      ['import', 'lists'],
      ['include', 'vault.hrl'],
    ],
  );
  assert.deepEqual(out.imports[0].names, [{ imported: 'sum', alias: 'sum' }]);
  assert.deepEqual(
    out.refs.filter((r) => r.kind === 'call').map((r) => [r.name, r.receiver]),
    [
      ['call', 'gen_server'],
      ['sum', 'lists'],
    ],
  );
});

test('cfml: <cfscript> blocks are embedded with absolute lines and block ids', async () => {
  const out = await extract('cfml', 'page.cfm', `<cfset greeting = "hi">
<cfscript>
    function greet(name) {
        writeOutput(greeting);
        return "Hello " & name;
    }
</cfscript>
<cfinclude template="header.cfm">
`);
  assert.equal(out.parseOk, true);
  const greet = sym(out, 'greet');
  assert.ok(greet, 'script function extracted');
  assert.equal(greet.block, 0);
  assert.deepEqual([greet.startLine, greet.endLine], [3, 6]);
  assert.deepEqual(out.blocks, [{ lang: 'cfscript', startLine: 2, endLine: 6 }]);
  const call = out.refs.find((r) => r.kind === 'call' && r.name === 'writeOutput');
  assert.equal(call.startLine, 4);
  // Refs carry no `block` field (CONTRACTS §6); the absolute line proves the offset was applied.
  assert.equal(out.refs.find((r) => r.name === 'greeting' && r.startLine === 4).symbol, out.symbols.indexOf(greet));
  assert.deepEqual(out.imports.map((i) => [i.kind, i.spec]), [['include', 'header.cfm']]);
});

test('cfml: tag-less script .cfc is one embedded block; plain HTML .cfm is left alone', async () => {
  const script = await extract('cfml', 'Vault.cfc', `component displayname="Vault" {
    public function init() { return this; }
}
`);
  assert.equal(script.parseOk, true);
  assert.equal(sym(script, 'Vault').kind, 'class');
  assert.equal(sym(script, 'init').kind, 'method');
  assert.equal(sym(script, 'init').qual, 'Vault.init');
  assert.equal(sym(script, 'init').startLine, 2);

  const html = await extract('cfml', 'index.cfm', `<html>
  <body>#title#</body>
</html>
`);
  assert.equal(html.parseOk, true);
  assert.equal(html.blocks.length, 0);
  assert.equal(html.symbols.length, 0);
});

test('cfml: tag-based component contains its cffunction members', async () => {
  const out = await extract('cfml', 'Tag.cfc', `<cfcomponent displayname="Tag">
    <cffunction name="init" access="private" returntype="any">
        <cfargument name="arg" type="string" required="true">
        <cfreturn this>
    </cffunction>
</cfcomponent>
`);
  const init = sym(out, 'init');
  assert.equal(init.kind, 'method');
  assert.equal(init.qual, 'Tag.init');
  assert.equal(init.signature, '(arg): any');
  assert.equal(init.exported, false);
});

test('solidity: new expressions are calls, error declarations are indexed, visibility drives exported', async () => {
  const out = await extract('solidity', 'C.sol', `pragma solidity ^0.8.0;
import "./Base.sol";

contract C {
    error Bad(uint256 x);
    uint256 private secret;
    uint256 public constant K = 1;

    function make() public returns (C c) {
        c = new C();
        emit Bad(1);
    }

    function hidden() internal view returns (uint256) {
        return secret;
    }
}
`);
  assert.equal(out.parseOk, true);
  assert.deepEqual(
    out.refs.filter((r) => r.kind === 'call').map((r) => r.name),
    ['C', 'Bad'],
  );
  assert.equal(sym(out, 'Bad').kind, 'other');
  assert.equal(sym(out, 'secret').exported, false);
  assert.equal(sym(out, 'K').exported, true);
  assert.equal(sym(out, 'hidden').exported, false);
  assert.equal(sym(out, 'make').exported, true);
  // `returns (C c)` and `new C()` are both `type` refs; the user_defined_type inside `new` survives.
  assert.deepEqual(
    out.refs.filter((r) => r.kind === 'type' && r.name === 'C').map((r) => r.startLine),
    [9, 10],
  );
});

test('pascal: method implementations are methods, multi-name vars are indexed, uses become imports', async () => {
  const out = await extract('pascal', 'U.pas', `unit U;

interface

uses Classes, SysUtils;

type
  TPoint = record
    X, Y: Integer;
  end;

  TVault = class(TObject)
  public
    function Deposit(const Amount: Currency): Boolean; virtual;
  end;

var
  A, B: Integer;

implementation

function TVault.Deposit(const Amount: Currency): Boolean;
var
  Local: Integer;
begin
  Result := Amount > Local;
end;

end.
`);
  assert.equal(out.parseOk, true);
  assert.deepEqual(
    out.symbols.map((s) => [s.kind, s.name, s.exported]),
    [
      ['struct', 'TPoint', true],
      ['field', 'X', true],
      ['field', 'Y', true],
      ['class', 'TVault', true],
      ['variable', 'A', true],
      ['variable', 'B', true],
      ['method', 'TVault.Deposit', true],
    ],
  );
  assert.deepEqual(out.imports.map((i) => i.spec), ['Classes', 'SysUtils']);
  assert.equal(sym(out, 'TVault.Deposit').signature, '(const Amount: Currency): Boolean');
  assert.ok(out.refs.some((r) => r.kind === 'type' && r.name === 'TObject'), 'inheritance is a type ref');
});

test('cobol: file-level pack yields empty results and never parses', async () => {
  const out = await extract('cobol', 'LEGDER.cbl', '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. X.\n');
  assert.deepEqual([out.parseOk, out.errorNodes, out.symbols.length, out.refs.length, out.imports.length], [true, 0, 0, 0, 0]);
  assert.equal(out.lang, 'cobol');
});
