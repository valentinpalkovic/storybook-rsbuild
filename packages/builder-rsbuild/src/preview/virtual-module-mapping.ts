import path from 'path'
import fs from 'fs'
import type {
  NormalizedStoriesSpecifier,
  Options,
  PreviewAnnotation,
} from '@storybook/types'
import { join, resolve } from 'path'
import {
  handlebars,
  loadPreviewOrConfigFile,
  normalizeStories,
  readTemplate,
} from '@storybook/core-common'
import slash from 'slash'
import { webpackIncludeRegexp } from '@storybook/core-webpack'
import { dedent } from 'ts-dedent'

export const getVirtualModules = async (options: Options) => {
  const virtualModules: Record<string, string> = {}
  const cwd = process.cwd()
  const workingDir = options.cache?.basePath || process.cwd()

  const isProd = options.configType === 'PRODUCTION'
  const nonNormalizedStories = await options.presets.apply('stories', [])
  const entries = []

  const stories = normalizeStories(nonNormalizedStories, {
    configDir: options.configDir,
    workingDir,
  })

  const realPathRelativeToCwd = path.relative(workingDir, cwd)

  const previewAnnotations = [
    ...(
      await options.presets.apply<PreviewAnnotation[]>(
        'previewAnnotations',
        [],
        options,
      )
    ).map((entry) => {
      // If entry is an object, use the absolute import specifier.
      // This is to maintain back-compat with community addons that bundle other addons
      // and package managers that "hide" sub dependencies (e.g. pnpm / yarn pnp)
      // The vite builder uses the bare import specifier.
      if (typeof entry === 'object') {
        return entry.absolute
      }

      return slash(entry)
    }),
    loadPreviewOrConfigFile(options),
  ].filter(Boolean)

  const storiesFilename = 'storybook-stories.js'
  const storiesPath = resolve(join(workingDir, storiesFilename))

  // TODO: Rspack doesn't support lazyCompilation yet
  // const builderOptions = await getBuilderOptions<BuilderOptions>(options)
  // const needPipelinedImport = !!builderOptions.lazyCompilation && !isProd
  const needPipelinedImport = !isProd
  virtualModules[storiesPath] = toImportFn(stories, realPathRelativeToCwd, {
    needPipelinedImport,
  })

  const configEntryPath = resolve(join(workingDir, 'storybook-config-entry.js'))
  virtualModules[configEntryPath] = handlebars(
    await readTemplate(
      require.resolve(
        'storybook-builder-rsbuild/templates/virtualModuleModernEntry.js.handlebars',
      ),
    ),
    {
      storiesFilename,
      previewAnnotations,
    },
    // We need to double escape `\` for webpack. We may have some in windows paths
  ).replace(/\\/g, '\\\\')
  entries.push(configEntryPath)

  Object.entries(virtualModules).forEach(([key, value]) => {
    fs.writeFileSync(key, value)
  })

  return {
    virtualModules,
    entries,
  }
}

// forked from @storybook/core-webpack
// Rspack do not support inputFileSystem, so webpack-virtual-modules is not supported here
// see https://github.com/web-infra-dev/rspack/issues/5091 for details
// https://github.com/rspack-contrib/rspack-plugins/blob/main/packages/plugin-virtual-module/README.md
// doesn't suffice for this use case as the resolve logic need to be rewritten as well
// use cache dir here

export function toImportFnPart(specifier: NormalizedStoriesSpecifier) {
  const { directory, importPathMatcher } = specifier

  // TODO: Rspack doesn't support `webpackInclude` magic comments
  // so the import() here will include all files in the directory
  return dedent`
      async (path) => {
        if (!${importPathMatcher}.exec(path)) {
          return;
        }

        const pathRemainder = path.substring(${directory.length + 1});
        return import(
          /* webpackChunkName: "[request]" */
          /* webpackInclude: ${webpackIncludeRegexp(specifier)} */
          '${directory}/' + pathRemainder
        );
      }

  `
}

export function toImportFn(
  stories: NormalizedStoriesSpecifier[],
  relativeOffset: string,
  { needPipelinedImport }: { needPipelinedImport?: boolean } = {},
) {
  let pipelinedImport = `const pipeline = (x) => x();`
  if (needPipelinedImport) {
    pipelinedImport = `
      const importPipeline = ${importPipeline};
      const pipeline = importPipeline();
    `
  }

  return dedent`
    ${pipelinedImport}

    const importers = [
      ${stories.map(toImportFnPart).join(',\n')}
    ];

    export async function importFn(path) {
      const offset = '${relativeOffset}';

      for (let i = 0; i < importers.length; i++) {
        const pathWithOffset = buildPath(offset, path)

        const moduleExports = await pipeline(() => importers[i](pathWithOffset));
        if (moduleExports) {
          return moduleExports;
        }
      }
    }

    function buildPath(offset, path) {
      if(path.startsWith('./')) {
        return offset + '/' + path.substring(2);
      } else {
        return offset + '/' + path;
      }
    }
  `
}

type ModuleExports = Record<string, any>

export function importPipeline() {
  let importGate: Promise<void> = Promise.resolve()

  return async (importFn: () => Promise<ModuleExports>) => {
    await importGate

    const moduleExportsPromise = importFn()
    importGate = importGate.then(async () => {
      await moduleExportsPromise
    })
    return moduleExportsPromise
  }
}
