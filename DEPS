# Copyright 2019 The Chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

use_relative_paths = True

vars = {
  'build_url': 'https://chromium.googlesource.com/chromium/src/build.git',
  'build_revision': '762c7888b95c2a5e9fd2c093425efb3c1060ec0b',

  'buildtools_url': 'https://chromium.googlesource.com/chromium/src/buildtools.git',
  'buildtools_revision': '2277272f7a7978c48f1b2c50d41af83485552235',

  'depot_tools_url': 'https://chromium.googlesource.com/chromium/tools/depot_tools.git',
  'depot_tools_revision': '60b433cf0b29e12218abbdf36a8d166fc59e7209',

  'inspector_protocol_url': 'https://chromium.googlesource.com/deps/inspector_protocol',
  'inspector_protocol_revision': '751c62b24e500dc80a40212627ee91331de8abdb',

  'clang_format_url': 'https://chromium.googlesource.com/chromium/llvm-project/cfe/tools/clang-format.git',
  'clang_format_revision': '96636aa0e9f047f17447f2d45a094d0b59ed7917',

  'emscripten_tag': '4764c5c323a474f7ba28ae991b0c9024fccca43c',

  # GN CIPD package version.
  'gn_version': 'git_revision:0d67e272bdb8145f87d238bc0b2cb8bf80ccec90',

  # Chromium build number for unit tests. It should be regularly updated to
  # the content of https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/LAST_CHANGE
  'chromium_linux': '841380',
  # the content of https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/LAST_CHANGE
  'chromium_win': '841307',
  # the content of https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/LAST_CHANGE
  'chromium_mac': '841377',
}

# Only these hosts are allowed for dependencies in this DEPS file.
# If you need to add a new host, contact chrome infrastracture team.
allowed_hosts = [ 'chromium.googlesource.com' ]

deps = {
  'buildtools/clang_format/script':
    Var('clang_format_url') + '@' + Var('clang_format_revision'),

  'buildtools':
    Var('buildtools_url') + '@' + Var('buildtools_revision'),

  'buildtools/linux64': {
    'packages': [
      {
        'package': 'gn/gn/linux-amd64',
        'version': Var('gn_version'),
      }
    ],
    'dep_type': 'cipd',
    'condition': 'host_os == "linux"',
  },
  'buildtools/mac': {
    'packages': [
      {
        'package': 'gn/gn/mac-amd64',
        'version': Var('gn_version'),
      }
    ],
    'dep_type': 'cipd',
    'condition': 'host_os == "mac"',
  },
  'buildtools/win': {
    'packages': [
      {
        'package': 'gn/gn/windows-amd64',
        'version': Var('gn_version'),
      }
    ],
    'dep_type': 'cipd',
    'condition': 'host_os == "win"',
  },
  'build':
    Var('build_url') + '@' + Var('build_revision'),
  'third_party/depot_tools':
    Var('depot_tools_url') + '@' + Var('depot_tools_revision'),
  'third_party/inspector_protocol':
    Var('inspector_protocol_url') + '@' + Var('inspector_protocol_revision'),
}

hooks = [
  # Pull down Node binaries for WebUI toolchain.
  {
    'name': 'node_linux64',
    'pattern': '.',
    'condition': 'host_os == "linux"',
    'action': [ 'python',
                'third_party/depot_tools/download_from_google_storage.py',
                '--no_resume',
                '--extract',
                '--no_auth',
                '--bucket', 'chromium-nodejs/12.14.1',
                '-s', 'third_party/node/linux/node-linux-x64.tar.gz.sha1',
    ],
  },
  {
    'name': 'node_mac',
    'pattern': '.',
    'condition': 'host_os == "mac"',
    'action': [ 'python',
                'third_party/depot_tools/download_from_google_storage.py',
                '--no_resume',
                '--extract',
                '--no_auth',
                '--bucket', 'chromium-nodejs/12.14.1',
                '-s', 'third_party/node/mac/node-darwin-x64.tar.gz.sha1',
    ],
  },
  {
    'name': 'node_win',
    'pattern': '.',
    'condition': 'host_os == "win"',
    'action': [ 'python',
                'third_party/depot_tools/download_from_google_storage.py',
                '--no_resume',
                '--no_auth',
                '--bucket', 'chromium-nodejs/12.14.1',
                '-s', 'third_party/node/win/node.exe.sha1',
    ],
  },

  {
    # Ensure that the DEPS'd "depot_tools" has its self-update capability
    # disabled.
    'name': 'disable_depot_tools_selfupdate',
    'pattern': '.',
    'action': [
        'python',
        'third_party/depot_tools/update_depot_tools_toggle.py',
        '--disable',
    ],
  },

  # Pull clang-format binaries using checked-in hashes.
  {
    'name': 'clang_format_win',
    'pattern': '.',
    'condition': 'host_os == "win"',
    'action': [ 'python',
                'third_party/depot_tools/download_from_google_storage.py',
                '--no_resume',
                '--no_auth',
                '--bucket', 'chromium-clang-format',
                '-s', 'buildtools/win/clang-format.exe.sha1',
    ],
  },
  {
    'name': 'clang_format_mac',
    'pattern': '.',
    'condition': 'host_os == "mac"',
    'action': [ 'python',
                'third_party/depot_tools/download_from_google_storage.py',
                '--no_resume',
                '--no_auth',
                '--bucket', 'chromium-clang-format',
                '-s', 'buildtools/mac/clang-format.sha1',
    ],
  },
  {
    'name': 'clang_format_linux',
    'pattern': '.',
    'condition': 'host_os == "linux"',
    'action': [ 'python',
                'third_party/depot_tools/download_from_google_storage.py',
                '--no_resume',
                '--no_auth',
                '--bucket', 'chromium-clang-format',
                '-s', 'buildtools/linux64/clang-format.sha1',
    ],
  },

  # Pull chromium from common storage
  {
    'name': 'download_chromium_win',
    'pattern': '.',
    'condition': 'host_os == "win"',
    'action': [ 'python',
                'scripts/deps/download_chromium.py',
                'https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/' + Var('chromium_win') + '/chrome-win.zip',
                'third_party/chrome',
                'chrome-win/chrome.exe',
                Var('chromium_win'),
    ],
  },
  {
    'name': 'download_chromium_mac',
    'pattern': '.',
    'condition': 'host_os == "mac"',
    'action': [ 'python',
                'scripts/deps/download_chromium.py',
                'https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/' + Var('chromium_mac') + '/chrome-mac.zip',
                'third_party/chrome',
                'chrome-mac/Chromium.app/Contents',
                Var('chromium_mac'),
    ],
  },
  {
    'name': 'download_chromium_linux',
    'pattern': '.',
    'condition': 'host_os == "linux"',
    'action': [ 'python',
                'scripts/deps/download_chromium.py',
                'https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/' + Var('chromium_linux') + '/chrome-linux.zip',
                'third_party/chrome',
                'chrome-linux/chrome',
                Var('chromium_linux'),
    ],
  },
  {
    'name': 'sysroot_x64',
    'pattern': '.',
    'condition': 'checkout_linux and checkout_x64',
    'action': ['python', 'build/linux/sysroot_scripts/install-sysroot.py',
               '--arch=x64'],
  },
  {
    'name': 'emscripten',
    'pattern': '.',
    'action': ['python', 'scripts/deps/download_emscripten.py', Var('emscripten_tag'), 'third_party/emscripten-releases'],
  },
]
