#!/usr/bin/env node
'use strict';
// Preview-only staging. No install, no launch, no deletion, no probe binary delivered.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const L = require('./lib.cjs');
const crate = path.resolve(__dirname, '..');
const allowPreview = status => status === 0;
async function gate(validate, stage) {
  const status = await validate();
  if (!allowPreview(status)) return 1;
  await stage();
  return 0;
}
async function main(args = process.argv.slice(2)) {
  const skip = args.includes('--skip-build');
  const rest = args.filter(a => a !== '--skip-build');
  if (rest.length !== 2 || rest[0] !== '--out' || !rest[1]) throw Error('uso: node packaging/preview.cjs [--skip-build] --out /tmp/nueva-preview');
  const out = path.resolve(rest[1]);
  if (!out.startsWith('/tmp/') || fs.existsSync(out)) throw Error('--out debe ser un directorio nuevo bajo /tmp (no se sobrescribe nada)');
  const parent = fs.realpathSync(path.dirname(out));
  if (parent !== '/tmp' && !parent.startsWith('/tmp/')) throw Error('--out no puede salir de /tmp mediante enlaces');
  const validator = require('./validate.cjs');
  const before = L.provenance(crate), fingerprint = validator.inputs();
  return gate(() => validator.main(skip ? ['--skip-build'] : []), async () => {
    // Cargo reuses its incremental build; never deliver the smoke/probe variant.
    const home = process.env.HOME;
    const sysroot = cp.execFileSync('rustc', ['--print', 'sysroot'], {encoding:'utf8',timeout:10000}).trim();
    const remap = [[crate,'/abito/src'],[process.env.CARGO_HOME || path.join(home,'.cargo'),'/abito/cargo'],[sysroot,'/abito/rust'],[home,'/abito/home']].map(([a,b])=>`--remap-path-prefix=${a}=${b}`).join(' ');
    const target = path.join(crate,'target-ship');
    const built = cp.spawnSync('cargo',['build','--release','--locked','--offline','--features','tauri/custom-protocol','--target-dir',target],{cwd:crate,stdio:'inherit',timeout:1800000,env:{...process.env,RUSTFLAGS:remap,CARGO_ENCODED_RUSTFLAGS:undefined}});
    if (built.status !== 0) throw Error('compilación de preview falló; no se prepara la preview');
    if (fingerprint !== validator.inputs() || JSON.stringify(before) !== JSON.stringify(L.provenance(crate))) throw Error('árbol cambió durante la validación');
    const binary = path.join(target,'release','abito-island');
    const bytes = fs.readFileSync(binary);
    for (const marker of ['ABITO_PROBE','AbitoValidate','validation_scene','validation_observation','validate-result','XTEST']) if (bytes.includes(Buffer.from(marker))) throw Error(`binario contiene marcador de prueba: ${marker}`);
    if (fs.realpathSync(path.dirname(out)) !== parent) throw Error('destino cambió durante la validación');
    fs.mkdirSync(out,{mode:0o700});
    fs.copyFileSync(binary,path.join(out,'abito-island'));
    fs.chmodSync(path.join(out,'abito-island'),0o700);
    fs.copyFileSync(path.join(crate,'icons/icon.png'),path.join(out,'abito-island.png'));
    fs.writeFileSync(path.join(out,'abito-island-launcher'),L.launcherText(),{mode:0o700});
    for (const [dir,files] of [['desktop-daemon',L.DAEMON_FILES],['desktop-harness',L.HARNESS_FILES], ['desktop-pi', L.PI_FILES]]) for (const file of files) {
      const dest = path.join(out,dir,file); fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700}); fs.copyFileSync(path.join(crate,'..',dir,file),dest);
    }
    fs.writeFileSync(path.join(out,'preview.json'),JSON.stringify({provenance:before,sha256:L.sha256File(binary),features:'tauri/custom-protocol (no probe)',inputs:fingerprint,validated:true},null,2));
    console.log(`Preview validada. No se ha iniciado. Ejecutar:\n${JSON.stringify(path.join(out,'abito-island-launcher'))}`);
  });
}
if (require.main === module) main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports = { allowPreview, gate, main };
