import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { MakerOptions } from '@electron-forge/maker-base';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerMSIX } from '@electron-forge/maker-msix';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const require = createRequire(import.meta.url);

// Development identity: what `npm run make:msix` uses, matching the self-signed
// certificate in certs/. It can be installed next to the Store version.
const DEV_IDENTITY = {
  packageIdentity: 'Looit.Dev',
  publisher: 'CN=Looit Dev',
  publisherDisplayName: 'Looit',
  packageDisplayName: 'Looit',
  appDisplayName: 'Looit',
  packageMinOSVersion: '10.0.19041.0',
  packageMaxOSVersionTested: '10.0.26100.0',
};

/**
 * The Store identity: copy store-identity.example.json to store-identity.json and
 * paste the values from Partner Center (Product management > Product identity).
 * They must match character for character. Without that file, or when
 * LOOIT_DEV_IDENTITY=1 (the dev build), the development identity is used.
 */
function loadIdentity(): typeof DEV_IDENTITY {
  const file = path.resolve('store-identity.json');
  if (process.env.LOOIT_DEV_IDENTITY === '1' || !existsSync(file)) return DEV_IDENTITY;
  const given = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const text = (key: string, required: boolean): string | undefined => {
    const value = given[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (required) throw new Error(`store-identity.json: "${key}" is missing (copy it from Partner Center).`);
    return undefined;
  };
  const publisher = text('publisher', true)!;
  if (!/^CN=\S/.test(publisher)) {
    throw new Error(
      'store-identity.json: "publisher" must start with CN= (for example CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX).',
    );
  }
  const displayName = text('packageDisplayName', false) ?? DEV_IDENTITY.packageDisplayName;
  return {
    ...DEV_IDENTITY,
    packageIdentity: text('packageIdentity', true)!,
    publisher,
    publisherDisplayName: text('publisherDisplayName', true)!,
    packageDisplayName: displayName,
    appDisplayName: displayName,
  };
}

const MSIX_IDENTITY = loadIdentity();

/**
 * The standard MSIX manifest plus an app execution alias, so other programs can
 * start the Store-installed app as `Looit.exe`. AI apps (Claude Desktop) start
 * `Looit.exe --mcp` this way: a packaged app's own folder can't be run directly.
 */
function msixManifest(version: string, description: string, arch: string): string {
  const template = readFileSync(
    path.join(
      path.dirname(require.resolve('electron-windows-msix/package.json')),
      'static/templates/AppxManifest.xml.in',
    ),
    'utf8',
  );
  const winVersion = [...version.split('.'), '0', '0', '0', '0'].slice(0, 4).join('.');
  const msixArch = arch === 'ia32' ? 'x86' : arch;
  const values: Record<string, string> = {
    IdentityName: MSIX_IDENTITY.packageIdentity,
    AppDisplayName: MSIX_IDENTITY.appDisplayName,
    MinOSVersion: MSIX_IDENTITY.packageMinOSVersion,
    MaxOSVersionTested: MSIX_IDENTITY.packageMaxOSVersionTested,
    Version: winVersion,
    DisplayName: MSIX_IDENTITY.packageDisplayName,
    PublisherName: MSIX_IDENTITY.publisher.replace(/^CN=/, ''),
    PublisherDisplayName: MSIX_IDENTITY.publisherDisplayName,
    PackageDescription: description,
    PackageBackgroundColor: 'transparent',
    AppExecutable: 'Looit.exe',
    ProcessorArchitecture: msixArch,
  };
  const filled = template.replace(/{{(\w+)}}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`Unknown MSIX manifest variable ${key}`);
    return values[key];
  });
  const alias = `      </uap:VisualElements>
      <Extensions>
        <uap3:Extension Category="windows.appExecutionAlias" Executable="app\\Looit.exe" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias>
            <desktop:ExecutionAlias Alias="Looit.exe" />
          </uap3:AppExecutionAlias>
        </uap3:Extension>
      </Extensions>`;
  if (!filled.includes('      </uap:VisualElements>')) throw new Error('Unexpected MSIX manifest template');
  return filled.replace('      </uap:VisualElements>', alias);
}

class MakerMSIXWithAlias extends MakerMSIX {
  async make(options: MakerOptions) {
    const dir = path.join(os.tmpdir(), 'looit-msix-manifest');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `AppxManifest-${options.targetArch}.xml`);
    writeFileSync(
      file,
      msixManifest(options.packageJSON.version, options.packageJSON.description ?? 'Looit', options.targetArch),
    );
    this.config = { ...this.config, appManifest: file };
    return super.make(options);
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'Looit',
    // Windows uses build/icon.ico (16-256 px) for the exe and its taskbar icon.
    icon: path.join('build', 'icon'),
    // The window icon is loaded at runtime; the Vite plugin keeps only .vite in
    // the asar, so the assets folder ships next to it in resources/.
    extraResource: ['assets'],
  },
  rebuildConfig: {},
  makers: [
    new MakerMSIXWithAlias({
      // Store/Start tile images generated from assets/logo.svg.
      packageAssets: path.join('build', 'msix'),
      windowsKitVersion: '10.0.26100.0',
      manifestVariables: MSIX_IDENTITY,
      // The Store build (npm run make:msix:store) is left unsigned: the Microsoft Store signs it.
      sign: process.env.LOOIT_UNSIGNED !== '1',
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.mts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.mts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }],
    }),
    // Fuses harden the packaged app before signing.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
