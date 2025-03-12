import core from '@embroider/core';
const { cleanUrl, packageName } = core;
import type { ImportKind, OnResolveResult, PluginBuild } from 'esbuild';
import { dirname } from 'path';

import type {
  PackageCachePublicAPI as PackageCache,
  Resolution,
  ModuleRequest,
  RequestAdapter,
  VirtualResponse,
} from '@embroider/core';
import { externalName } from '@embroider/reverse-exports';

export class EsBuildRequestAdapter implements RequestAdapter<Resolution<OnResolveResult, OnResolveResult>> {
  static create({
    packageCache,
    phase,
    build,
    kind,
    path,
    importer,
    pluginData,
  }: {
    packageCache: PackageCache;
    phase: 'bundling' | 'other';
    build: PluginBuild;
    kind: ImportKind;
    path: string;
    importer: string | undefined;
    pluginData: Record<string, any> | undefined;
  }) {
    if (!(pluginData?.embroider?.enableCustomResolver ?? true)) {
      return;
    }

    if (path && importer && path[0] !== '\0' && !path.startsWith('virtual-module:')) {
      let fromFile = cleanUrl(importer);
      if (process.platform === 'win32') {
        // embroider uses real OS paths for filenames. Vite and Esbuild don't do so consistently.
        fromFile = fromFile.replace(/\//g, '\\');
      }
      return {
        initialState: {
          specifier: path,
          fromFile,
          meta: pluginData?.embroider?.meta,
        },
        adapter: new EsBuildRequestAdapter(packageCache, phase, build, kind),
      };
    }
  }

  private constructor(
    private packageCache: PackageCache,
    private phase: 'bundling' | 'other',
    private context: PluginBuild,
    private kind: ImportKind
  ) {}

  get debugType() {
    return 'esbuild';
  }

  notFoundResponse(
    request: ModuleRequest<Resolution<OnResolveResult, OnResolveResult>>
  ): Resolution<OnResolveResult, OnResolveResult> {
    return {
      type: 'not_found',
      err: {
        errors: [{ text: `module not found ${request.specifier}` }],
      },
    };
  }

  virtualResponse(
    _request: ModuleRequest<Resolution<OnResolveResult, OnResolveResult>>,
    virtual: VirtualResponse
  ): Resolution<OnResolveResult, OnResolveResult> {
    return {
      type: 'found',
      filename: virtual.specifier,
      result: { path: virtual.specifier, namespace: 'embroider-virtual', pluginData: { virtual } },
      virtual,
    };
  }

  async resolve(
    request: ModuleRequest<Resolution<OnResolveResult, OnResolveResult>>
  ): Promise<Resolution<OnResolveResult, OnResolveResult>> {
    requestStatus(request.specifier);

    let result = await this.context.resolve(request.specifier, {
      importer: request.fromFile,
      resolveDir: dirname(request.fromFile),
      kind: this.kind,
      pluginData: {
        embroider: {
          enableCustomResolver: false,
          meta: request.meta,
        },
      },
    });

    let status = readStatus(request.specifier);

    if (result.errors.length > 0 || status.type === 'not_found') {
      return { type: 'not_found', err: result };
    } else {
      if (this.phase === 'bundling') {
        // we need to ensure that we don't traverse back into the app while
        // doing dependency pre-bundling. There are multiple ways an addon can
        // resolve things from the app, due to the existince of both app-js
        // (modules in addons that are logically part of the app's namespace)
        // and non-strict handlebars (which resolves
        // components/helpers/modifiers against the app's global pool).
        let pkg = this.packageCache.ownerOfFile(result.path);
        if (
          pkg?.root === this.packageCache.appRoot &&
          // vite provides node built-in polyfills under a custom namespace and we dont
          // want to interrupt that. We'd prefer they get bundled in the dep optimizer normally,
          // rather than getting deferred to the app build (which also works, but means they didn't
          // get pre-optimized).
          (result.namespace === 'file' || result.namespace.startsWith('embroider-'))
        ) {
          let externalizedName = request.specifier;
          if (!packageName(externalizedName)) {
            // the request was a relative path. This won't remain valid once
            // it has been bundled into vite/deps. But we know it targets the
            // app, so we can always convert it into a non-relative import
            // from the app's namespace
            //
            // IMPORTANT: whenever an addon resolves a relative path to the
            // app, it does so because our code in the core resolver has
            // rewritten the request to be relative to the app's root. So here
            // we will only ever encounter relative paths that are already
            // relative to the app's root directory.
            externalizedName = externalName(pkg.packageJSON, externalizedName) || externalizedName;
          }
          return {
            type: 'found',
            filename: externalizedName,
            virtual: false,
            result: {
              path: externalizedName,
              external: true,
            },
          };
        }
      }

      let filename: string;
      if (status.type === 'found' && result.external) {
        // when we know that the file was really found, but vite has
        // externalized it, report the true filename that was found, not the
        // externalized request path.
        filename = status.filename;
      } else {
        filename = result.path;
      }

      return {
        type: 'found',
        filename,
        result,
        virtual: false,
      };
    }
  }
}

/*
  This is an unfortunate necessity. During depscan, vite deliberately hides
  information from esbuild. Specifically, it treats "not found" and "this is an
  external dependency" as both "external: true". But we really care about the
  difference, since we have fallback behaviors for the "not found" case. Using
  this global state, our rollup resolver plugin can observe what vite is
  actually doing and communicate that knowledge outward to our esbuild resolver
  plugin.
 */
function sharedGlobalState() {
  let channel = (globalThis as any).__embroider_vite_resolver_channel__ as undefined | Map<string, InternalStatus>;
  if (!channel) {
    channel = new Map();
    (globalThis as any).__embroider_vite_resolver_channel__ = channel;
  }
  return channel;
}

function requestStatus(id: string): void {
  sharedGlobalState().set(id, { type: 'pending' });
}

export function writeStatus(id: string, status: InternalStatus): void {
  let channel = sharedGlobalState();
  if (channel.get(id)?.type === 'pending') {
    channel.set(id, status);
  }
}

function readStatus(id: string): InternalStatus {
  let channel = sharedGlobalState();
  let result = channel.get(id) ?? { type: 'pending' };
  channel.delete(id);
  return result;
}

type InternalStatus = { type: 'pending' } | { type: 'not_found' } | { type: 'found'; filename: string };
