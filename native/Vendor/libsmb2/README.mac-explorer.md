# libsmb2 source dependency

Upstream: https://github.com/sahlberg/libsmb2
Pinned commit: `57fea04fd29403e3978000179339c8e13ce46b5c`
License: LGPL-2.1-or-later; see COPYING and LICENCE-LGPL-2.1.txt.

Unmodified top-level C/header sources from lib/ and include/ are vendored for offline reproducible builds. SwiftPM compiles only the macOS client source list from upstream lib/CMakeLists.txt, without Kerberos, QUIC, RDMA or server examples. CommonCrypto supplies Apple AES.

Local integration files: include/MacExplorerSMB2Includes.h, include/module.modulemap and include/config.h. config.h was generated with CMake on macOS with ENABLE_LIBKRB5=OFF and ENABLE_GSSAPI=OFF; it contains platform feature probes, no machine paths or credentials. It additionally defines HAVE_ARC4RANDOM_BUF, matching the separate definition in upstream CMakeLists.txt, so NTLM challenges and SMB3 nonces use the macOS CSPRNG rather than the library fallback. Upstream sources are supplied to permit rebuilding/relinking; do not replace this source dependency with an opaque binary.

## Source and rebuilding

Exact upstream source archive: https://github.com/sahlberg/libsmb2/archive/57fea04fd29403e3978000179339c8e13ce46b5c.tar.gz

The application is distributed under the repository's GPL-3.0 license. Its complete source tree includes this library's C/header sources, original per-file notices, the SwiftPM source list in native/Package.swift, and native/scripts/build.py. From the matching application source revision, edit or replace the library sources and run `python3 -I native/scripts/build.py --validation` to rebuild and relink the application. No opaque prebuilt SMB library is required. Preserve this notice, COPYING, LICENCE-LGPL-2.1.txt, and source availability with distributions.
