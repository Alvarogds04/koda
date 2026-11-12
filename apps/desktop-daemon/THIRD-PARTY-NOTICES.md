# Third-party notices

## Gentle Dot (adapted code)

Parts of this package are adapted from the Gentle Dot project
(`packages/daemon`: `supervisor.ts`, `isolation.ts`, `jsonl.ts`, and the product
identity document `identity.md`), used as the MIT-licensed reference for the
supervised isolated RPC runtime, fail-closed private directory checks, strict JSONL
fring, and product-identity approach.

- Files adapted: `src/isolation.cjs`, `src/runtime.cjs` (in part), `test/fixtures` and
  `identity.md` (concept), `README.md` (in part)
- Changes: rewritten in plain Node CJS with no third-party dependencies; Abito
  identity, island paths, environment allowlist and fail-closed path rules differ from
  the original; supervision state machine and JSONL framing closely follow the
  original.

Gentle Dot is distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 Gentleman Programming

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Coucou (mechanics only)

The published bundle uses Coucou’s MECHANICS only: the MIT-licensed code,
Copyright (c) 2026 Louis Raillé. Mochi’s look, sounds, icons and images are
not used (Coucou `LICENSE-ASSETS.md`); Abito keeps its own clay character and
ports no Coucou assets.

Coucou is distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 Louis Raillé

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

This package carries no other third-party runtime or test dependencies.

## sherpa-onnx (speech to text in the Koda binaries)

Koda's binaries (`abito-island`, and `abito-transcribe`, the helper that transcribes Minikoda videos) link
sherpa-onnx 1.13.8 statically: the `sherpa-onnx` and `sherpa-onnx-sys` crates
(https://github.com/k2-fsa/sherpa-onnx, crates.io) and its prebuilt static libraries from the project's GitHub release
v1.13.8. Koda only recognises speech, never synthesises it, so on Linux and Windows it links the upstream libraries
built with `-DSHERPA_ONNX_ENABLE_TTS=OFF` (`sherpa-onnx-v1.13.8-<os>-static-no-tts-lib`): the text-to-speech path —
`piper_phonemize`, `espeak-ng` (GPL-3.0) and the `ucd` tables — is **not** part of these binaries and therefore needs no
notice here (see `apps/desktop-tauri/docs/dictation-build.md`). macOS still links the default libraries, espeak-ng
included, until that build is changed. The speech models are not part of Koda: they are downloaded on the user's request
from Hugging Face, each under its own licence (shown in Ajustes → Voz).

sherpa-onnx is distributed under the Apache License 2.0 (the crate's `LICENSE`; no `NOTICE` file is published with
it). The full text follows.

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## ONNX Runtime (inside sherpa-onnx's static libraries)

The sherpa-onnx static libraries include ONNX Runtime (`libonnxruntime.a` / `onnxruntime.lib`,
https://github.com/microsoft/onnxruntime), linked into the same binaries.

ONNX Runtime is distributed under the MIT License:

```text
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## FFmpeg (Linux and Windows installers)

The Linux and Windows installers ship FFmpeg as a separate program, `runtime/ffmpeg` (Linux) or `runtime\ffmpeg.exe`
(Windows), inside Koda's bundled runtime. The daemon runs it, unmodified and with command-line arguments only, to
extract and split the audio of videos a Minikoda reads (K2-13). The macOS installer ships no FFmpeg (no LGPL macOS
build is available yet), so video transcription is unavailable there.

FFmpeg is free software licensed under the GNU Lesser General Public License version 3 or later (LGPL-3.0-or-later).
The shipped binary is an LGPL build by BtbN/FFmpeg-Builds: it is configured with `--enable-version3` and built without
`--enable-gpl` and without `--enable-nonfree`, and Koda's runtime build refuses any other build. Its licence text is
`runtime/LICENSE.ffmpeg.txt`, installed next to it.

- Exact binaries, pinned by SHA-256 in `apps/desktop-tauri/packaging/runtime/ffmpeg.sha256`:
  `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-11-12-39/ffmpeg-n9.0.2-49-gc179411bbb-linux64-lgpl-9.0.tar.xz`
  and `.../ffmpeg-n9.0.2-49-gc179411bbb-win64-lgpl-9.0.zip`.
- Corresponding Source: FFmpeg at revision `c179411bbb2864cc71323d3055acda25d5c2aace` — the commit that FFmpeg's
  own version string labels `n9.0.2-49-gc179411bbb`, a label and not the identity,
  https://github.com/FFmpeg/FFmpeg/tree/c179411bbb2864cc71323d3055acda25d5c2aace — plus the build scripts and the exact
  versions of the libraries linked into it, https://github.com/BtbN/FFmpeg-Builds (release autobuild-2026-11-11-12-39).
- Source access (GPL-3.0 §6(d), incorporated by LGPL-3.0 — the clause that applies to a downloadable installer):
  whoever downloads a Koda installer has to be able to obtain that Corresponding Source from a designated place (a
  network server or an equivalent) in the same way they obtained the binary, with clear directions next to the
  download. A written offer to send the source on request is GPL-3.0 §6(b), the clause for a copy handed over in a
  physical product; on its own, it is NOT sufficient for a download.
- **Not done yet, before a public release.** Koda does not mirror that Corresponding Source itself, so no designated
  place exists yet and the §6(d) obligation above is unmet: the mirror must exist and be linked from this notice and
  from the download page **before Koda's first public release**, and it has to carry the BtbN/FFmpeg-Builds scripts
  and the library versions they name as well. As an additional measure — not a substitute — Koda offers a copy on
  request (GPL-3.0 §6(b)): for at least three years after we ship a version of Koda that contains this FFmpeg, anyone
  who received it can ask the Koda maintainers (through the issue tracker of the repository Koda is published from)
  for the Corresponding Source described above, provided for no more than the cost of making and sending the copy. The
  licence review of FFmpeg (LGPL-3.0 obligations and the AAC/H.264 patent question recorded in
  `odd/tasks/k2-13-minikodas.md`) has **NOT** been done. This paragraph is an engineering record, not legal advice.
- You may replace `runtime/ffmpeg[.exe]` with your own build of FFmpeg: Koda only calls it by that path.

## yt-dlp (Linux and Windows installers)

The Linux and Windows installers ship yt-dlp as a separate program, `runtime/yt-dlp` (Linux) or `runtime\yt-dlp.exe`
(Windows), inside Koda's bundled runtime. The daemon runs it, unmodified and with command-line arguments only, to read
the YouTube links a Minikoda finds in a post: its own subtitles first, and only when a video has none, its audio (which
the daemon then transcribes). K2-13 T2c-8 (S19). The macOS installer ships no yt-dlp and no ffmpeg, so YouTube links are
not read there.

yt-dlp is released into the public domain under the Unlicense; its text is `runtime/LICENSE.yt-dlp.txt`, installed next
to the binary. The official standalone executables are PyInstaller bundles: they also carry Python (PSF-2.0) and
third-party components, including **copyleft** ones — GNU Readline (GPL-3.0-or-later, bundled as its own shared object),
mutagen (GPL-2.0-or-later), libidn2/libunistring/libintl (LGPL-3.0-or-later / LGPL-2.1-or-later) and libstdc++/libgcc
(GPL-3.0 with the GCC exception). Their texts, verbatim from the release, are `runtime/THIRD-PARTY-NOTICES.yt-dlp.txt`.

- Exact binaries, pinned by SHA-256 in `apps/desktop-tauri/packaging/runtime/ytdlp.sha256`:
  `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux` and `.../yt-dlp.exe`. The runtime build
  also refuses a file that is not an official PyInstaller standalone build.
- Corresponding Source: the yt-dlp source at tag `2026.10.26`, https://github.com/yt-dlp/yt-dlp/tree/2026.10.26, and the
  source of each bundled component from its original project; yt-dlp states that its maintainers provide the bundled
  components' source on request (maintainers@yt-dlp.org) as the licences require.
- Source access (GPL-3.0 §6(d), through the GPL-3.0-or-later components — the clause that applies to a downloadable
  installer): recipients have to be able to obtain that Corresponding Source from a designated place, in the same way
  they obtained the binary, with clear directions next to the download. A written offer alone (GPL-3.0 §6(b)) is NOT
  sufficient for a download.
- **Not done yet, before a public release.** Koda does not mirror those sources itself, so no designated place exists
  yet and the obligation above is unmet: the mirror must exist and be linked from this notice and from the download
  page before Koda's first public release. As an additional measure — not a substitute — Koda offers a copy on request
  (GPL-3.0 §6(b)) for at least three years after shipping a version that contains it. The licence review of yt-dlp and
  of the copyleft components inside its standalone builds has **NOT** been done. This paragraph is an engineering
  record, not legal advice.
- YouTube's own terms do not allow downloading outside its apps. Reading a link through its subtitles, or through a
  downloaded audio track when it has none, was a knowing product decision (K2-13 decision L33).
- YouTube breaks yt-dlp regularly, so this pin is refreshed often (tag, both SHA-256 values from the release's
  `SHA2-256SUMS`, and the two licence texts): a binary that no longer extracts is expected, not a defect of Koda's.
- You may replace `runtime/yt-dlp[.exe]` with your own build of yt-dlp: Koda only calls it by that path.
