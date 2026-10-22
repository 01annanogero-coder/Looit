// Builds the MSIX package (out/make/msix/x64/*.msix).
//
//   npm run make:msix          Dev build. Identity "Looit.Dev", signed with a local self-signed
//                              certificate so it can be installed for testing. Never upload this one.
//   npm run make:msix:store    Store build. Identity from store-identity.json (Partner Center values),
//                              left unsigned on purpose: the Microsoft Store signs it. Upload this one.
//
// The dev certificate is created once with Windows PowerShell (no pwsh needed) and kept in certs/.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const storeBuild = process.argv.includes('--store');
const identityFile = path.resolve('store-identity.json');
const msixDir = path.resolve('out', 'make', 'msix');

const certDir = path.resolve('certs');
const pfx = path.join(certDir, 'dev-cert.pfx');
const cer = path.join(certDir, 'dev-cert.cer');
const passFile = path.join(certDir, 'dev-cert.password');
// Must match the dev publisher in forge.config.mts.
const subject = 'CN=Looit Dev';

if (storeBuild && !existsSync(identityFile)) {
  console.error(
    'store-identity.json is missing.\n' +
      'Reserve the app name in Partner Center, then copy store-identity.example.json to store-identity.json\n' +
      'and fill in the values from Product management > Product identity.',
  );
  process.exit(1);
}

if (!storeBuild && !existsSync(pfx)) {
  mkdirSync(certDir, { recursive: true });
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passFile, password);
  const script = `
$ErrorActionPreference = 'Stop'
$cert = New-SelfSignedCertificate -Type CodeSigning -Subject '${subject}' -FriendlyName 'Looit Dev MSIX signing' \`
  -KeyUsage DigitalSignature -KeySpec Signature -KeyLength 2048 -KeyExportPolicy Exportable \`
  -NotAfter (Get-Date).AddYears(5) -CertStoreLocation 'cert:\\CurrentUser\\My'
$pw = ConvertTo-SecureString -String '${password}' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath '${pfx}' -Password $pw | Out-Null
Export-Certificate -Cert $cert -FilePath '${cer}' | Out-Null
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' });
  console.log(`Created dev certificate: ${cer}`);
}

// Forge's MSIX maker refuses to overwrite an existing package, so a rebuild
// after a successful build would fail with "dest already exists".
rmSync(msixDir, { recursive: true, force: true });

const env = { ...process.env };
delete env.WINDOWS_CERTIFICATE_FILE;
delete env.WINDOWS_CERTIFICATE_PASSWORD;
delete env.LOOIT_DEV_IDENTITY;
delete env.LOOIT_UNSIGNED;
if (storeBuild) {
  // A Store build gets no certificate at all: the Store signs the package.
  env.LOOIT_UNSIGNED = '1';
} else {
  env.LOOIT_DEV_IDENTITY = '1';
  env.WINDOWS_CERTIFICATE_FILE = pfx;
  env.WINDOWS_CERTIFICATE_PASSWORD = readFileSync(passFile, 'utf8').trim();
}

const result = spawnSync('npx', ['electron-forge', 'make'], { stdio: 'inherit', shell: true, env });
if (result.status !== 0) process.exit(result.status ?? 1);

// Show the identity that actually went into the package.
const found = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.msix')) found.push(full);
  }
};
if (existsSync(msixDir)) walk(msixDir);
if (found.length !== 1) {
  console.error(`Expected one .msix in ${msixDir}, found ${found.length}.`);
  process.exit(1);
}
const msix = found[0];
const manifest = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead($env:MSIX_FILE)
$r = New-Object IO.StreamReader($z.GetEntry('AppxManifest.xml').Open())
$r.ReadToEnd(); $r.Close(); $z.Dispose()`,
  ],
  { env: { ...process.env, MSIX_FILE: msix }, encoding: 'utf8' },
);
const identity = /<Identity\s[^>]*>/.exec(manifest)?.[0] ?? '(no Identity element found)';
const display = /<PublisherDisplayName>([^<]*)</.exec(manifest)?.[1] ?? '(none)';
console.log(`\nPackage:   ${msix}`);
console.log(`Identity:  ${identity.replace(/\s+/g, ' ')}`);
console.log(`Publisher display name: ${display}`);
console.log(
  storeBuild
    ? 'Unsigned Store package: upload it in Partner Center.'
    : 'Dev package, signed with certs/dev-cert.pfx: for local testing only.',
);
