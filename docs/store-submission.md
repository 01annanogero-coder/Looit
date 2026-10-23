# Microsoft Store submission checklist

The code side is finished. What is left needs a Partner Center login, a clean Windows
machine, or a decision from the owner. Work through the sections in order.

## 1. Reserve the app name and copy the identity (Partner Center)

1. Partner Center > Apps and games > New product > **MSIX or PWA app**. Reserve the name **Looit**.
2. Open the product > Product management > **Product identity**. Copy three values exactly:
   - `Package/Identity/Name`
   - `Package/Identity/Publisher` (looks like `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`)
   - `Package/Properties/PublisherDisplayName`
3. Copy `store-identity.example.json` to `store-identity.json` and paste them in. Never type them by hand: one wrong
   character and the upload is rejected.

## 2. Build the package to upload

```
npm run make:msix:store
```

The result is `out\make\msix\x64\Looit-win32-x64-<version>.msix`. The script prints the identity that went into it;
check it against Partner Center. This package is **unsigned on purpose**: the Store signs it after validation, so no
code-signing certificate is needed. Do not upload the output of `npm run make:msix` (that is the dev build, identity
`Looit.Dev`).

Each new submission needs a higher `version` in `package.json`. The manifest version is derived from it (1.0.1 becomes
1.0.1.0); the last part must stay 0 for the Store.

## 3. Install-test the package (never done yet)

The Store-identity package cannot be installed locally, but the dev package carries the same code, manifest
capabilities, alias and assets. Test that one on a clean Windows 10/11 machine or VM:

1. Turn on **Developer Mode** (Settings > System > For developers). This fixes error `0x80073CFF`.
2. In an **administrator** PowerShell, trust the dev certificate (this fixes error `0x800B0109`):
   `Import-Certificate -FilePath certs\dev-cert.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople`
3. `Add-AppxPackage out\make\msix\x64\Looit-win32-x64-<version>.msix` (run `npm run make:msix` first).
4. Close any development copy of Looit first (`npm start`): it holds the same single-instance lock, so the installed app
   would hand off to it and quit within two seconds. Then start Looit from the Start menu and check: it opens, a second click on the icon only focuses the open window,
   Help > About Looit shows the version, create a project, edit, close it quickly (the Save and close prompt appears),
   export a short video, and `Looit --mcp` works from the execution alias.
5. Remove the test install afterwards: `Get-AppxPackage Looit.Dev | Remove-AppxPackage`, and remove the certificate
   from Trusted People if you do not need it again.

Changing system trust and Developer Mode needs an administrator, so it is left to you.

## 4. Store listing (Partner Center)

| Item                | What is needed                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Privacy policy URL  | A public page for Looit. The privacy draft below can go in the Privacy Center of annandigitallabs.com (it lists a policy per app).                                                         |
| Support contact     | A support website or email, for example the support page of annandigitallabs.com.                                                                                                          |
| Screenshots         | At least one PNG, 1366x768 or larger (1920x1080 recommended). Use the demo project: editor, a finished frame, the library screen.                                                          |
| Description         | See the draft below.                                                                                                                                                                       |
| Category            | Pick the closest to video creation (for example Photo and video); confirm in the Partner Center list.                                                                                      |
| Pricing             | Free or paid, markets, and release date.                                                                                                                                                   |
| Age rating          | Complete the questionnaire honestly. Looit shows web pages the user chooses, so answer the open internet / web content questions yes; expect a rating above the lowest tier.               |
| Package declaration | Looit declares `runFullTrust` (a desktop app) and `internetClient`. Partner Center asks you to justify `runFullTrust`: it is an Electron desktop app that writes project files and videos. |

### Description (draft)

> Looit turns real websites into 3D animated explainer videos.
>
> Put any web page on a browser card in a 3D scene, add a virtual cursor that moves, clicks, scrolls and types, and
> export a smooth MP4 (H.264) in up to 1080p at 60 fps. Every frame is rendered exactly, so the same project always
> produces the same video.
>
> - Several website panels in one scene, each with its own cursor
> - Text overlays pinned to the video frame, with readable pills and shadows
> - Camera moves and one-click animation presets (fade, fly in, push in, pan and more)
> - Solid, gradient or image backgrounds, with a reflective or grid floor
> - A keyframe timeline with Blender-style shortcuts
> - Projects save automatically as .looit files in your own folder
> - Optional: let an AI app that supports MCP, such as Claude Desktop, build a video for you (off until you turn it on)
>
> Looit needs an internet connection to load the websites you want to record.

Check every line against the current app before submitting; remove anything that changes.

### Privacy policy (draft, for the Looit page of the Privacy Center)

> **Looit privacy policy**
>
> Looit does not collect, store or send personal data to its developer. There are no accounts, no analytics and no
> telemetry.
>
> **What stays on your device.** Your projects (.looit files, by default in your user folder under "Looit Projects"),
> the videos you export, your layout settings and a short error log (crashes and unexpected errors, no project
> content) are stored on your device. The error log is never uploaded; you can open its folder from Help > About Looit
> and send it to support if you choose to.
>
> **Websites you add.** When you add a website to a project, Looit loads it directly from that website, like a
> browser. That website's own privacy policy applies to it. Looit runs pages in an isolated browser, denies permission
> requests (camera, location and similar) and blocks downloads.
>
> **AI connection.** Optional and off by default. When you turn it on, an AI app on your own computer can talk to Looit
> over a local connection. Looit itself sends nothing to any AI service; what the AI app does with its data is governed
> by that app's policy.
>
> **Children.** Looit is not directed at children.
>
> **Contact.** contact@annandigitallabs.com
>
> Last updated: <date>

The statements above were checked against the code on 2026-10-22: the app makes no network requests of its own beyond
loading the websites the user adds, and the AI connection is a local pipe that defaults to off. Recheck them when
that changes.

## 5. Submit

Upload the `.msix` on the Packages page, fill in the listing and age rating, add notes for certification (how to try
the app: open the Demo project, press Preview, then Export video), and submit. Certification normally takes up to a few
business days.
