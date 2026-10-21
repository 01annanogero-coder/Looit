import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Development identity. Before Store submission these are replaced with
// the values Partner Center assigns (Package/Identity/Name and Publisher).
const MSIX_IDENTITY = {
  packageIdentity: 'Looit.Dev',
  publisher: 'CN=Looit Dev',
  publisherDisplayName: 'Looit',
  packageDisplayName: 'Looit',
  appDisplayName: 'Looit',
  packageMinOSVersion: '10.0.19041.0',
  packageMaxOSVersionTested: '10.0.26100.0',
};

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
