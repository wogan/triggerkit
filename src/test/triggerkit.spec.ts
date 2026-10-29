import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  triggerkit,
  transformSvelteKitEnvImports,
  extractEnvironmentVariables,
  generateAppEnvModuleContent
} from '../lib/triggerkit';
import type { BuildExtension } from '@trigger.dev/build/extensions';
import fs from 'fs';
import { fail } from 'assert';

// Create simple mocks for the fs functions we use
vi.mock('fs', () => ({
  default: {
    promises: {
      readdir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(''),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockResolvedValue(undefined)
    },
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() }),
    readFileSync: vi.fn().mockReturnValue('')
  }
}));

// Mock the path module
vi.mock('path', () => ({
  default: {
    resolve: vi.fn((...paths) => paths.join('/')),
    dirname: vi.fn((p) => p.split('/').slice(0, -1).join('/')),
    basename: vi.fn((p) => p.split('/').pop()),
    join: vi.fn((...paths) => paths.join('/')),
    relative: vi.fn((from, to) => to)
  }
}));

// Sample file content with environment variables
const sampleContent = `
import { DATABASE_URL } from '$env/static/private';
import { PUBLIC_API_URL } from '$env/static/public';

export async function getDbConfig() {
  return {
    url: DATABASE_URL,
    apiUrl: PUBLIC_API_URL
  };
}
`;

describe('Triggerkit Extension', () => {
  let extension: BuildExtension;
  let mockContext: any;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Setup mocks
    fs.promises.readdir = vi.fn().mockImplementation((path) => {
      if (path.includes('src/lib')) {
        return Promise.resolve([{ name: 'db.ts', isFile: () => true, isDirectory: () => false }]);
      }
      return Promise.resolve([]);
    });

    fs.promises.readFile = vi.fn().mockResolvedValue(sampleContent);
    fs.existsSync = vi.fn().mockReturnValue(true);

    // Create mock context
    mockContext = {
      workingDir: '/test/project',
      logger: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      registerPlugin: vi.fn(),
      addLayer: vi.fn()
    };

    // Create extension
    extension = triggerkit({
      includeDirs: ['src/lib'] // Make sure the directory matches our mock
    });
  });

  // Basic test for extension
  it('should initialize with default options', () => {
    expect(extension).toBeDefined();
    expect(extension.name).toBe('triggerkit');
  });

  // Test core functionality directly
  it('should transform legacy $env/static imports to process.env', () => {
    const input = `import { API_KEY } from '$env/static/private';`;
    const result = transformSvelteKitEnvImports(input);

    expect(result).toContain('const { API_KEY } = process.env;');
    expect(result).not.toContain('$env/static/private');
  });

  it('should transform $app/env/private imports to process.env', () => {
    const input = `import { API_KEY, DB_URL } from '$app/env/private';`;
    const result = transformSvelteKitEnvImports(input);

    expect(result).toContain('const { API_KEY, DB_URL } = process.env;');
    expect(result).not.toContain('$app/env/private');
  });

  it('should transform $app/env/public imports to process.env', () => {
    const input = `import { PUBLIC_API_URL } from '$app/env/public';`;
    const result = transformSvelteKitEnvImports(input);

    expect(result).toContain('const { PUBLIC_API_URL } = process.env;');
    expect(result).not.toContain('$app/env/public');
  });

  it('should transform base $app/env imports to runtime constants', () => {
    const input = `import { browser, dev } from '$app/env';`;
    const result = transformSvelteKitEnvImports(input);

    expect(result).toContain('const browser = false;');
    expect(result).toContain("const dev = process.env.NODE_ENV !== 'production';");
    expect(result).not.toContain("from '$app/env'");
    // Must not be confused with $app/env/private or $app/env/public
    expect(transformSvelteKitEnvImports(`import { X } from '$app/env/private';`)).toContain(
      'const { X } = process.env;'
    );
  });

  it('should generate $app/env virtual module content with all constants', () => {
    const content = generateAppEnvModuleContent();

    expect(content).toContain('export const browser = false;');
    expect(content).toContain('export const building = false;');
    expect(content).toContain("export const dev = process.env.NODE_ENV !== 'production';");
    expect(content).toContain("export const version = process.env.npm_package_version ?? '';");
  });

  it('should extract env var names from $app/env and $env/static imports', () => {
    const source = [
      `import { API_KEY } from '$app/env/private';`,
      `import { PUBLIC_API_URL } from '$app/env/public';`,
      `import { LEGACY_KEY } from '$env/static/private';`
    ].join('\n');

    const envVars = new Set<string>();
    extractEnvironmentVariables(source, envVars);

    expect(envVars).toEqual(new Set(['API_KEY', 'PUBLIC_API_URL', 'LEGACY_KEY']));
  });

  // Test full build process
  it('should run onBuildStart without errors', async () => {
    if (extension.onBuildStart) {
      console.log('Mock context:', JSON.stringify({ ...mockContext, logger: 'mocked' }));
      await extension.onBuildStart(mockContext);

      // Mock fs.readdir to return files
      fs.promises.readdir = vi
        .fn()
        .mockResolvedValue([{ name: 'db.ts', isFile: () => true, isDirectory: () => false }]);

      // Create a mock file with exported functions
      const fileWithFunctions = `
        import { DB_URL } from '$env/static/private';
        export function getDbConfig() {
          return DB_URL;
        }
      `;
      fs.promises.readFile = vi.fn().mockResolvedValue(fileWithFunctions);

      try {
        // Call the hook with our mock context
        await extension.onBuildStart(mockContext);

        // Log what was called
        console.log('registerPlugin called:', mockContext.registerPlugin.mock.calls.length);
        console.log('logger.log called:', mockContext.logger.log.mock.calls.length);
        console.log('logger.warn called:', mockContext.logger.warn.mock.calls.length);

        // Verify the plugin was registered or at least some logging happened
        expect(
          mockContext.registerPlugin.mock.calls.length > 0 ||
            mockContext.logger.log.mock.calls.length > 0
        ).toBeTruthy();
      } catch (error) {
        console.error('Error in onBuildStart:', error);
        fail(`onBuildStart threw an error: ${error}`);
      }
    }
  });
});
