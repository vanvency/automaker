import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateSyntheticDiffForNewFile,
  appendUntrackedFileDiffs,
  listAllFilesInDirectory,
  generateDiffsForNonGitDirectory,
  getGitRepositoryDiffs,
  getCommittedBranchDiffs,
  collectRangeSubmoduleDiffs,
  collectWorkingTreeSubmoduleDiffs,
  collectCommitSetDiffs,
  parseRawGitlinkChanges,
  prefixSubmoduleDiff,
  parseShortstat,
  truncateToUtf8Bytes,
  worktreePrefixesFromList,
  isInsideNestedWorktree,
  normalizeCommitText,
  extractChildIndex,
  extractChildIndexes,
  resolveTaskCommitMatcher,
  matchesTaskCommit,
  isParentTask,
  selectTaskCommits,
} from '../src/diff';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('diff.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-utils-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('generateSyntheticDiffForNewFile', () => {
    it('should generate diff for binary file', async () => {
      const fileName = 'test.png';
      const filePath = path.join(tempDir, fileName);
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const diff = await generateSyntheticDiffForNewFile(tempDir, fileName);

      expect(diff).toContain(`diff --git a/${fileName} b/${fileName}`);
      expect(diff).toContain('new file mode 100644');
      expect(diff).toContain(`Binary file ${fileName} added`);
    });

    it('should generate diff for large text file', async () => {
      const fileName = 'large.txt';
      const filePath = path.join(tempDir, fileName);
      // Create a file > 1MB
      const largeContent = 'x'.repeat(1024 * 1024 + 100);
      await fs.writeFile(filePath, largeContent);

      const diff = await generateSyntheticDiffForNewFile(tempDir, fileName);

      expect(diff).toContain(`diff --git a/${fileName} b/${fileName}`);
      expect(diff).toContain('[File too large to display:');
      expect(diff).toMatch(/\d+KB\]/);
    });

    it('should generate diff for small text file with trailing newline', async () => {
      const fileName = 'test.txt';
      const filePath = path.join(tempDir, fileName);
      const content = 'line 1\nline 2\nline 3\n';
      await fs.writeFile(filePath, content);

      const diff = await generateSyntheticDiffForNewFile(tempDir, fileName);

      expect(diff).toContain(`diff --git a/${fileName} b/${fileName}`);
      expect(diff).toContain('new file mode 100644');
      expect(diff).toContain('--- /dev/null');
      expect(diff).toContain(`+++ b/${fileName}`);
      expect(diff).toContain('@@ -0,0 +1,3 @@');
      expect(diff).toContain('+line 1');
      expect(diff).toContain('+line 2');
      expect(diff).toContain('+line 3');
      expect(diff).not.toContain('\\ No newline at end of file');
    });

    it('should generate diff for text file without trailing newline', async () => {
      const fileName = 'no-newline.txt';
      const filePath = path.join(tempDir, fileName);
      const content = 'line 1\nline 2';
      await fs.writeFile(filePath, content);

      const diff = await generateSyntheticDiffForNewFile(tempDir, fileName);

      expect(diff).toContain(`diff --git a/${fileName} b/${fileName}`);
      expect(diff).toContain('+line 1');
      expect(diff).toContain('+line 2');
      expect(diff).toContain('\\ No newline at end of file');
    });

    it('should generate diff for empty file', async () => {
      const fileName = 'empty.txt';
      const filePath = path.join(tempDir, fileName);
      await fs.writeFile(filePath, '');

      const diff = await generateSyntheticDiffForNewFile(tempDir, fileName);

      expect(diff).toContain(`diff --git a/${fileName} b/${fileName}`);
      expect(diff).toContain('@@ -0,0 +1,0 @@');
    });

    it('should generate diff for single line file', async () => {
      const fileName = 'single.txt';
      const filePath = path.join(tempDir, fileName);
      await fs.writeFile(filePath, 'single line\n');

      const diff = await generateSyntheticDiffForNewFile(tempDir, fileName);

      expect(diff).toContain('@@ -0,0 +1,1 @@');
      expect(diff).toContain('+single line');
    });

    it('should handle file not found error', async () => {
      const fileName = 'nonexistent.txt';

      const diff = await generateSyntheticDiffForNewFile(tempDir, fileName);

      expect(diff).toContain(`diff --git a/${fileName} b/${fileName}`);
      expect(diff).toContain('[Unable to read file content]');
    });

    it('should handle empty directory path gracefully', async () => {
      const dirName = 'some-directory';
      const dirPath = path.join(tempDir, dirName);
      await fs.mkdir(dirPath);

      const diff = await generateSyntheticDiffForNewFile(tempDir, dirName);

      expect(diff).toContain(`diff --git a/${dirName} b/${dirName}`);
      expect(diff).toContain('new file mode 040000');
      expect(diff).toContain('[Empty directory]');
    });

    it('should expand directory with files and generate diffs for each file', async () => {
      const dirName = 'new-feature';
      const dirPath = path.join(tempDir, dirName);
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'index.ts'), 'export const foo = 1;\n');
      await fs.writeFile(path.join(dirPath, 'utils.ts'), 'export const bar = 2;\n');

      const diff = await generateSyntheticDiffForNewFile(tempDir, dirName);

      // Should contain diffs for both files in the directory
      expect(diff).toContain(`diff --git a/${dirName}/index.ts b/${dirName}/index.ts`);
      expect(diff).toContain(`diff --git a/${dirName}/utils.ts b/${dirName}/utils.ts`);
      expect(diff).toContain('+export const foo = 1;');
      expect(diff).toContain('+export const bar = 2;');
      // Should NOT contain a diff for the directory itself
      expect(diff).not.toContain('[Empty directory]');
    });

    it('should handle directory path with trailing slash', async () => {
      const dirName = 'trailing-slash-dir';
      const dirPath = path.join(tempDir, dirName);
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'file.txt'), 'content\n');

      // git status reports untracked directories with trailing slash
      const diff = await generateSyntheticDiffForNewFile(tempDir, `${dirName}/`);

      expect(diff).toContain(`diff --git a/${dirName}/file.txt b/${dirName}/file.txt`);
      expect(diff).toContain('+content');
    });
  });

  describe('appendUntrackedFileDiffs', () => {
    it('should return existing diff when no untracked files', async () => {
      const existingDiff = 'diff --git a/test.txt b/test.txt\n';
      const files = [
        { status: 'M', path: 'test.txt' },
        { status: 'A', path: 'new.txt' },
      ];

      const result = await appendUntrackedFileDiffs(tempDir, existingDiff, files);

      expect(result).toBe(existingDiff);
    });

    it('should append synthetic diffs for untracked files', async () => {
      const existingDiff = 'existing diff\n';
      const untrackedFile = 'untracked.txt';
      const filePath = path.join(tempDir, untrackedFile);
      await fs.writeFile(filePath, 'content\n');

      const files = [
        { status: 'M', path: 'modified.txt' },
        { status: '?', path: untrackedFile },
      ];

      const result = await appendUntrackedFileDiffs(tempDir, existingDiff, files);

      expect(result).toContain('existing diff');
      expect(result).toContain(`diff --git a/${untrackedFile} b/${untrackedFile}`);
      expect(result).toContain('+content');
    });

    it('should handle multiple untracked files', async () => {
      const file1 = 'file1.txt';
      const file2 = 'file2.txt';
      await fs.writeFile(path.join(tempDir, file1), 'file1\n');
      await fs.writeFile(path.join(tempDir, file2), 'file2\n');

      const files = [
        { status: '?', path: file1 },
        { status: '?', path: file2 },
      ];

      const result = await appendUntrackedFileDiffs(tempDir, '', files);

      expect(result).toContain(`diff --git a/${file1} b/${file1}`);
      expect(result).toContain(`diff --git a/${file2} b/${file2}`);
      expect(result).toContain('+file1');
      expect(result).toContain('+file2');
    });

    it('reports skipped untracked files by count, not as bytes', async () => {
      const file1 = 'budget-1.txt';
      const file2 = 'budget-2.txt';
      await fs.writeFile(path.join(tempDir, file1), 'x\n');
      await fs.writeFile(path.join(tempDir, file2), 'y\n');

      const files = [
        { status: '?', path: file1 },
        { status: '?', path: file2 },
      ];

      // Budget only fits the first synthetic diff.
      const firstSize = Buffer.byteLength(
        await generateSyntheticDiffForNewFile(tempDir, file1),
        'utf8'
      );
      const result = await appendUntrackedFileDiffs(tempDir, '', files, firstSize);

      expect(result).toContain('+x');
      expect(result).not.toContain('+y');
      expect(result).toContain('1 untracked file was not included');
      expect(result).not.toContain('more bytes');
    });

    it('does not split a multi-byte character when cutting to a byte budget', () => {
      // Each '中' is 3 bytes: a 7-byte budget must not leave half a character.
      const truncated = truncateToUtf8Bytes('中'.repeat(5), 7);

      expect(truncated).toBe('中中');
      expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(7);
      expect(truncated).not.toContain('\uFFFD');
    });
  });

  describe('listAllFilesInDirectory', () => {
    it('should list files in empty directory', async () => {
      const files = await listAllFilesInDirectory(tempDir);
      expect(files).toEqual([]);
    });

    it('should list files in flat directory', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'content');
      await fs.writeFile(path.join(tempDir, 'file2.js'), 'code');

      const files = await listAllFilesInDirectory(tempDir);

      expect(files).toHaveLength(2);
      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.js');
    });

    it('should list files in nested directories', async () => {
      await fs.mkdir(path.join(tempDir, 'subdir'));
      await fs.writeFile(path.join(tempDir, 'root.txt'), '');
      await fs.writeFile(path.join(tempDir, 'subdir', 'nested.txt'), '');

      const files = await listAllFilesInDirectory(tempDir);

      expect(files).toHaveLength(2);
      expect(files).toContain('root.txt');
      expect(files).toContain('subdir/nested.txt');
    });

    it('should skip node_modules directory', async () => {
      await fs.mkdir(path.join(tempDir, 'node_modules'));
      await fs.writeFile(path.join(tempDir, 'app.js'), '');
      await fs.writeFile(path.join(tempDir, 'node_modules', 'package.js'), '');

      const files = await listAllFilesInDirectory(tempDir);

      expect(files).toHaveLength(1);
      expect(files).toContain('app.js');
      expect(files).not.toContain('node_modules/package.js');
    });

    it('should skip common build directories', async () => {
      await fs.mkdir(path.join(tempDir, 'dist'));
      await fs.mkdir(path.join(tempDir, 'build'));
      await fs.mkdir(path.join(tempDir, '.next'));
      await fs.writeFile(path.join(tempDir, 'source.ts'), '');
      await fs.writeFile(path.join(tempDir, 'dist', 'output.js'), '');
      await fs.writeFile(path.join(tempDir, 'build', 'output.js'), '');

      const files = await listAllFilesInDirectory(tempDir);

      expect(files).toHaveLength(1);
      expect(files).toContain('source.ts');
    });

    it('should skip hidden files except .env', async () => {
      await fs.writeFile(path.join(tempDir, '.hidden'), '');
      await fs.writeFile(path.join(tempDir, '.env'), '');
      await fs.writeFile(path.join(tempDir, 'visible.txt'), '');

      const files = await listAllFilesInDirectory(tempDir);

      expect(files).toHaveLength(2);
      expect(files).toContain('.env');
      expect(files).toContain('visible.txt');
      expect(files).not.toContain('.hidden');
    });

    it('should skip .git directory', async () => {
      await fs.mkdir(path.join(tempDir, '.git'));
      await fs.writeFile(path.join(tempDir, '.git', 'config'), '');
      await fs.writeFile(path.join(tempDir, 'README.md'), '');

      const files = await listAllFilesInDirectory(tempDir);

      expect(files).toHaveLength(1);
      expect(files).toContain('README.md');
    });
  });

  describe('generateDiffsForNonGitDirectory', () => {
    it('should generate diffs for all files in directory', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'content1\n');
      await fs.writeFile(path.join(tempDir, 'file2.js'), "console.log('hi');\n");

      const result = await generateDiffsForNonGitDirectory(tempDir);

      expect(result.files).toHaveLength(2);
      expect(result.files.every((f) => f.status === '?')).toBe(true);
      expect(result.diff).toContain('diff --git a/file1.txt b/file1.txt');
      expect(result.diff).toContain('diff --git a/file2.js b/file2.js');
      expect(result.diff).toContain('+content1');
      expect(result.diff).toContain("+console.log('hi');");
    });

    it('should return empty result for empty directory', async () => {
      const result = await generateDiffsForNonGitDirectory(tempDir);

      expect(result.files).toEqual([]);
      expect(result.diff).toBe('');
    });

    it('should mark all files as untracked', async () => {
      await fs.writeFile(path.join(tempDir, 'test.txt'), 'test');

      const result = await generateDiffsForNonGitDirectory(tempDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].status).toBe('?');
      expect(result.files[0].statusText).toBe('New');
    });
  });

  describe('getGitRepositoryDiffs', () => {
    it('should treat non-git directory as all new files', async () => {
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'content\n');

      const result = await getGitRepositoryDiffs(tempDir);

      expect(result.hasChanges).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].status).toBe('?');
      expect(result.diff).toContain('diff --git a/file.txt b/file.txt');
    });

    it('should return no changes for empty non-git directory', async () => {
      const result = await getGitRepositoryDiffs(tempDir);

      expect(result.hasChanges).toBe(false);
      expect(result.files).toEqual([]);
      expect(result.diff).toBe('');
    });

    it('should surface nested changes from a dirty submodule', async () => {
      const execFile = (await import('util')).promisify((await import('child_process')).execFile);
      const run = async (command: string, cwd: string) =>
        execFile('/bin/sh', ['-c', command], { cwd });

      await run('git init', tempDir);
      await run('git config user.email t@example.com && git config user.name t', tempDir);
      await fs.writeFile(path.join(tempDir, 'root.txt'), 'root\n');
      await run('git add . && git commit -m init', tempDir);

      const submoduleDir = path.join(tempDir, 'submodule');
      await fs.mkdir(submoduleDir);
      await run('git init', submoduleDir);
      await run('git config user.email t@example.com && git config user.name t', submoduleDir);
      await fs.writeFile(path.join(submoduleDir, 'nested.txt'), 'nested\n');
      await run('git add . && git commit -m init', submoduleDir);

      // Register the nested repo as a submodule, then change it after the parent commit.
      await run(
        `git -c protocol.file.allow=always submodule add --name submodule -- ./submodule submodule`,
        tempDir
      );
      await run('git commit -m "add submodule"', tempDir);
      await fs.writeFile(path.join(submoduleDir, 'nested.txt'), 'nested changed\n');
      await fs.writeFile(path.join(submoduleDir, 'new.txt'), 'new\n');

      const result = await getGitRepositoryDiffs(tempDir);

      expect(result.hasChanges).toBe(true);
      expect(result.files.some((file) => file.path === 'submodule/nested.txt')).toBe(true);
      expect(result.files.some((file) => file.path === 'submodule/new.txt')).toBe(true);
      expect(result.diff).toContain('diff --git a/submodule/nested.txt b/submodule/nested.txt');
      expect(result.diff).toContain('+nested changed');
      expect(result.diff).toContain('diff --git a/submodule/new.txt b/submodule/new.txt');
    });
  });

  describe('submodule change expansion', () => {
    const execFile = (command: string, cwd: string, args: string[] = []) =>
      new Promise<string>((resolve, reject) => {
        import('child_process').then(({ execFile: execFileCb }) => {
          execFileCb(command, args, { cwd }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
        });
      });

    /** Create a parent repo with one submodule, committed and initialised. */
    async function initRepoWithSubmodule(root: string) {
      const git = async (cwd: string, args: string[]) => execFile('git', cwd, args);

      await git(root, ['init']);
      await git(root, ['config', 'user.email', 't@example.com']);
      await git(root, ['config', 'user.name', 't']);
      await fs.writeFile(path.join(root, 'root.txt'), 'root\n');
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);

      const subDir = path.join(root, 'submodule');
      await fs.mkdir(subDir);
      await git(subDir, ['init']);
      await git(subDir, ['config', 'user.email', 't@example.com']);
      await git(subDir, ['config', 'user.name', 't']);
      await fs.writeFile(path.join(subDir, 'nested.txt'), 'nested\n');
      await git(subDir, ['add', '.']);
      await git(subDir, ['commit', '-m', 'sub init']);

      await git(root, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--name',
        'submodule',
        '--',
        './submodule',
        'submodule',
      ]);
      await git(root, ['commit', '-m', 'add submodule']);
      return subDir;
    }

    const git = (cwd: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        import('child_process').then(({ execFile: execFileCb }) => {
          execFileCb('git', args, { cwd }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
        });
      });

    it('reports the submodule name, commits and file counts', async () => {
      const subDir = await initRepoWithSubmodule(tempDir);
      const baseCommit = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();

      // Real work inside the submodule, then a gitlink bump in the parent.
      await fs.writeFile(path.join(subDir, 'nested.txt'), 'nested changed\n');
      await fs.writeFile(path.join(subDir, 'added.txt'), 'added\n');
      await git(subDir, ['add', '.']);
      await git(subDir, ['commit', '-m', 'sub work']);
      await git(tempDir, ['add', 'submodule']);
      await git(tempDir, ['commit', '-m', 'bump submodule']);

      const result = await getCommittedBranchDiffs(tempDir, baseCommit);

      const summary = result.submodules?.find((entry) => entry.path === 'submodule');
      expect(summary).toBeDefined();
      expect(summary?.status).toBe('modified');
      expect(summary?.oldCommit).toBeTruthy();
      expect(summary?.newCommit).toBeTruthy();
      expect(summary?.oldCommit).not.toBe(summary?.newCommit);
      expect(summary?.filesChanged).toBe(2);
      expect(summary?.insertions).toBeGreaterThan(0);
      expect(summary?.error).toBeUndefined();

      // The submodule's own files are surfaced with the submodule path prefix.
      expect(result.files.some((file) => file.path === 'submodule/nested.txt')).toBe(true);
      expect(result.files.some((file) => file.path === 'submodule/added.txt')).toBe(true);
      expect(result.diff).toContain('diff --git a/submodule/nested.txt b/submodule/nested.txt');
      expect(result.diff).toContain('+nested changed');
      expect(result.diff).toContain('diff --git a/submodule/added.txt b/submodule/added.txt');
      expect(result.diff).toContain('+added');
    });

    it('keeps the parent diff while adding submodule content', async () => {
      const subDir = await initRepoWithSubmodule(tempDir);
      const baseCommit = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();

      await fs.writeFile(path.join(subDir, 'nested.txt'), 'changed inside submodule\n');
      await git(subDir, ['add', '.']);
      await git(subDir, ['commit', '-m', 'sub work']);
      await fs.writeFile(path.join(tempDir, 'root.txt'), 'root changed\n');
      await git(tempDir, ['add', '.']);
      await git(tempDir, ['commit', '-m', 'bump submodule + root']);

      const result = await getCommittedBranchDiffs(tempDir, baseCommit);

      expect(result.diff).toContain('diff --git a/root.txt b/root.txt');
      expect(result.diff).toContain('+root changed');
      expect(result.diff).toContain('diff --git a/submodule/nested.txt b/submodule/nested.txt');
    });

    it('marks the submodule diff as truncated when the byte budget runs out', async () => {
      const subDir = await initRepoWithSubmodule(tempDir);
      const baseCommit = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();

      await fs.writeFile(path.join(subDir, 'nested.txt'), `${'x'.repeat(2000)}\n`);
      await git(subDir, ['add', '.']);
      await git(subDir, ['commit', '-m', 'sub work']);
      await git(tempDir, ['add', 'submodule']);
      await git(tempDir, ['commit', '-m', 'bump submodule']);

      const result = await getCommittedBranchDiffs(tempDir, baseCommit, 512);

      const summary = result.submodules?.find((entry) => entry.path === 'submodule');
      expect(summary?.truncated).toBe(true);
      expect(result.diff).toContain('[diff truncated:');
    });

    it('reports submodules that are not initialised instead of failing', async () => {
      const subDir = await initRepoWithSubmodule(tempDir);
      const baseCommit = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();

      await fs.writeFile(path.join(subDir, 'nested.txt'), 'work\n');
      await git(subDir, ['add', '.']);
      await git(subDir, ['commit', '-m', 'sub work']);
      await git(tempDir, ['add', 'submodule']);
      await git(tempDir, ['commit', '-m', 'bump submodule']);

      // Simulate a worktree where the submodule was never checked out.
      await fs.rm(subDir, { recursive: true, force: true });

      const result = await getCommittedBranchDiffs(tempDir, baseCommit);

      const summary = result.submodules?.find((entry) => entry.path === 'submodule');
      expect(summary?.error).toMatch(/not initialised/i);
      // The gitlink record itself is still reported by the parent diff.
      expect(result.files.some((file) => file.path === 'submodule')).toBe(true);
    });

    it('collectRangeSubmoduleDiffs returns nothing for a range without submodule moves', async () => {
      await initRepoWithSubmodule(tempDir);
      const baseCommit = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();
      await fs.writeFile(path.join(tempDir, 'root.txt'), 'root changed\n');
      await git(tempDir, ['add', '.']);
      await git(tempDir, ['commit', '-m', 'root only']);

      const result = await collectRangeSubmoduleDiffs(tempDir, baseCommit, 'HEAD');

      expect(result.summaries).toEqual([]);
      expect(result.files).toEqual([]);
      expect(result.diff).toBe('');
    });

    it('includes staged edits inside submodules', async () => {
      const subDir = await initRepoWithSubmodule(tempDir);
      await fs.writeFile(path.join(subDir, 'nested.txt'), 'staged content\n');
      await git(subDir, ['add', 'nested.txt']);
      const result = await collectWorkingTreeSubmoduleDiffs(tempDir, [
        { status: 'M', path: 'submodule', statusText: 'Modified' },
      ]);
      expect(result.diff).toContain('+staged content');
      expect(result.files.map((file) => file.path)).toContain('submodule/nested.txt');
    });

    it('combines newest-first task commits into the full gitlink range', async () => {
      const subDir = await initRepoWithSubmodule(tempDir);
      await fs.writeFile(path.join(subDir, 'nested.txt'), 'second\n');
      await git(subDir, ['add', 'nested.txt']);
      await git(subDir, ['commit', '-m', 'second']);
      await git(tempDir, ['add', 'submodule']);
      await git(tempDir, ['commit', '-m', 'first bump']);
      const first = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();
      await fs.writeFile(path.join(subDir, 'nested.txt'), 'third\n');
      await git(subDir, ['add', 'nested.txt']);
      await git(subDir, ['commit', '-m', 'third']);
      await git(tempDir, ['add', 'submodule']);
      await git(tempDir, ['commit', '-m', 'second bump']);
      const second = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();
      const result = await collectCommitSetDiffs(tempDir, [second, first], {
        submodulesOnly: true,
      });
      expect(result.files.map((file) => file.path)).toContain('submodule/nested.txt');
      expect(result.diff).toContain('+third');
      expect(result.diff).not.toContain('-second');
    });

    it('collectWorkingTreeSubmoduleDiffs prefixes uncommitted submodule changes', async () => {
      const subDir = await initRepoWithSubmodule(tempDir);
      await fs.writeFile(path.join(subDir, 'nested.txt'), 'nested changed\n');
      await fs.writeFile(path.join(subDir, 'brand-new.txt'), 'new\n');

      const statusEntries = [
        { status: 'M', path: 'submodule', statusText: 'Modified' },
        { status: 'M', path: 'root.txt', statusText: 'Modified' },
      ];
      const result = await collectWorkingTreeSubmoduleDiffs(tempDir, statusEntries);

      expect(result.summaries).toHaveLength(1);
      expect(result.summaries[0]).toMatchObject({
        path: 'submodule',
        status: 'uncommitted',
        filesChanged: 2,
      });
      expect(result.files.map((file) => file.path).sort()).toEqual([
        'submodule/brand-new.txt',
        'submodule/nested.txt',
      ]);
      expect(result.diff).toContain('diff --git a/submodule/nested.txt b/submodule/nested.txt');
      expect(result.diff).toContain(
        'diff --git a/submodule/brand-new.txt b/submodule/brand-new.txt'
      );
    });
  });

  describe('submodule parsing helpers', () => {
    it('parses raw gitlink entries from -z output', () => {
      const raw = [
        ':160000 160000 97695cae1281df1d8d94307a4160b6c7a6722f6a 327e4c889401df723ee7d70e13ab0d3be520099c M',
        'frontend/saas-frontend',
        '',
        ':100644 100644 aaa bbb M',
        'src/index.ts',
        '',
      ].join('\0');

      expect(parseRawGitlinkChanges(raw)).toEqual([
        {
          path: 'frontend/saas-frontend',
          oldSha: '97695cae1281df1d8d94307a4160b6c7a6722f6a',
          newSha: '327e4c889401df723ee7d70e13ab0d3be520099c',
          status: 'modified',
        },
      ]);
    });

    it('classifies added and removed submodules', () => {
      const zero = '0000000000000000000000000000000000000000';
      const sha = '97695cae1281df1d8d94307a4160b6c7a6722f6a';
      const raw = [
        `:000000 160000 ${zero} ${sha} A\tsub/added`,
        `:160000 000000 ${sha} ${zero} D\tsub/removed`,
        '',
      ].join('\n');

      expect(parseRawGitlinkChanges(raw)).toEqual([
        { path: 'sub/added', oldSha: zero, newSha: sha, status: 'added' },
        { path: 'sub/removed', oldSha: sha, newSha: zero, status: 'removed' },
      ]);
    });

    it('prefixes submodule diff headers with the submodule path', () => {
      const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n');

      const prefixed = prefixSubmoduleDiff(diff, 'frontend/saas-frontend');

      expect(prefixed).toContain(
        'diff --git a/frontend/saas-frontend/src/a.ts b/frontend/saas-frontend/src/a.ts'
      );
      expect(prefixSubmoduleDiff(diff, '')).toBe(diff);
    });

    it('parses insertion and deletion totals from shortstat', () => {
      expect(parseShortstat('802 files changed, 45767 insertions(+), 23248 deletions(-)')).toEqual({
        insertions: 45767,
        deletions: 23248,
      });
      expect(parseShortstat('1 file changed, 1 insertion(+)')).toEqual({
        insertions: 1,
        deletions: 0,
      });
      expect(parseShortstat('')).toEqual({ insertions: 0, deletions: 0 });
    });
  });

  describe('task commit matching', () => {
    it('normalizes separators so #AIP-114878 and AIP114878 match', () => {
      expect(normalizeCommitText('feat: thing #AIP-114878')).toBe('featthingaip114878');
      expect(matchesTaskCommit('feat: thing #AIP-114878', { jiraKey: 'AIP-114878' })).toBe(true);
      expect(matchesTaskCommit('feat: thing AIP114878', { jiraKey: 'AIP-114878' })).toBe(true);
      expect(matchesTaskCommit('feat: unrelated AIP-999999', { jiraKey: 'AIP-114878' })).toBe(
        false
      );
    });

    it('does not treat AIP-1148780 as AIP-114878', () => {
      expect(matchesTaskCommit('chore: AIP-1148780 other epic', { jiraKey: 'AIP-114878' })).toBe(
        false
      );
    });

    it('extracts child markers from ids and titles', () => {
      expect(extractChildIndexes('chore(AIP-1): advance gitlinks (child 12)')).toEqual([12]);
      expect(extractChildIndexes('chore: child-3 work')).toEqual([3]);
      expect(extractChildIndexes('chore: child 07 work')).toEqual([7]);
      expect(extractChildIndex('aip-114878-child-9', 'AIP-114878 child 9: x')).toBe(9);
      expect(extractChildIndex('jira-dodo-aip-114878')).toBeNull();
    });

    it('matches a sub-task by Jira key and child index, without prefix collisions', () => {
      const matcher = { jiraKey: 'AIP-114878', childIndex: 1 };

      expect(matchesTaskCommit('chore: gitlinks for child-1 (AIP-114878)', matcher)).toBe(true);
      expect(matchesTaskCommit('chore(AIP-114878): advance submodules (child 1)', matcher)).toBe(
        true
      );
      // child 12 must not satisfy child 1
      expect(matchesTaskCommit('chore(AIP-114878): advance (child 12)', matcher)).toBe(false);
      // other epic
      expect(matchesTaskCommit('chore(AIP-114900): advance (child 1)', matcher)).toBe(false);
      // no child marker at all
      expect(matchesTaskCommit('chore(AIP-114878): root MR', matcher)).toBe(false);
    });

    it('builds a matcher from a feature and returns null without a Jira key', () => {
      expect(resolveTaskCommitMatcher({ id: 'aip-114878-child-3', jiraKey: 'AIP-114878' })).toEqual(
        { jiraKey: 'AIP-114878', childIndex: 3 }
      );
      expect(
        resolveTaskCommitMatcher({ id: 'jira-dodo-aip-114878', jiraKey: 'AIP-114878' })
      ).toEqual({ jiraKey: 'AIP-114878', childIndex: null });
      expect(resolveTaskCommitMatcher({ id: 'local-thing' })).toBeNull();
      expect(resolveTaskCommitMatcher(null)).toBeNull();
    });

    it('detects parent tasks that own child features', () => {
      const parent = {
        id: 'jira-dodo-aip-114878',
        title: 'AIP-114878: epic',
        jiraKey: 'AIP-114878',
      };
      const children = [
        parent,
        { id: 'aip-114878-child-1', title: 'AIP-114878 child 1: something' },
      ];

      expect(isParentTask(parent, children)).toBe(true);
      expect(isParentTask(children[1], children)).toBe(false);
      expect(isParentTask(parent, [parent])).toBe(false);
    });

    const commits = [
      { sha: 'a'.repeat(40), subject: 'chore(AIP-114878): child 12 work', author: 'x', date: '' },
      {
        sha: 'b'.repeat(40),
        subject: 'chore(AIP-114878): child 1 work #AIP-114878',
        author: 'x',
        date: '',
      },
      { sha: 'c'.repeat(40), subject: 'chore(AIP-114878): child 2 work', author: 'x', date: '' },
    ];

    it('narrows to the task commits when only some of the branch matches', () => {
      const selection = selectTaskCommits(commits, {
        matcher: { jiraKey: 'AIP-114878', childIndex: 1 },
      });

      expect(selection.mode).toBe('task');
      expect(selection.commits.map((commit) => commit.subject)).toEqual([
        'chore(AIP-114878): child 1 work #AIP-114878',
      ]);
      expect(selection.info).toMatchObject({
        mode: 'task',
        reason: 'task-commits',
        jiraKey: 'AIP-114878',
        childIndex: 1,
        matchedCommits: 1,
        totalCommits: 3,
      });
    });

    it('narrows a shared branch by Jira key when the card has no child marker', () => {
      // Real shape of `jira/aip-114866-dodo`: every commit is tagged with its own
      // task key, and several tasks share the branch.
      const shared = [
        {
          sha: 'a'.repeat(40),
          subject: '[AIP-114927] [AIP-114931] chore(root): update gitlink',
          author: 'x',
          date: '',
        },
        {
          sha: 'b'.repeat(40),
          subject: '[AIP-114946] [AIP-114949] chore(submodule): update gitlink',
          author: 'x',
          date: '',
        },
        {
          sha: 'c'.repeat(40),
          subject: '[AIP-114927] [AIP-114930] chore(root): update sophon-mind',
          author: 'x',
          date: '',
        },
      ];

      const selection = selectTaskCommits(shared, {
        matcher: { jiraKey: 'AIP-114927', childIndex: null },
      });

      expect(selection.mode).toBe('task');
      expect(selection.commits).toHaveLength(2);
      expect(selection.info).toMatchObject({
        mode: 'task',
        reason: 'task-commits',
        jiraKey: 'AIP-114927',
        matchedCommits: 2,
        totalCommits: 3,
      });
    });

    it('keeps the whole branch for parents, missing keys, no matches and forced scope', () => {
      const matcher = { jiraKey: 'AIP-114878', childIndex: 1 };

      expect(selectTaskCommits(commits, { matcher, isParent: true }).info.reason).toBe(
        'parent-task'
      );
      // No child marker: narrow by Jira key only, still scoped to the task.
      expect(
        selectTaskCommits(commits, {
          matcher: { jiraKey: 'AIP-114878' },
          isParent: false,
        }).info.reason
      ).toBe('all-commits-match');
      expect(selectTaskCommits(commits, {}).info.reason).toBe('no-jira-key');
      expect(
        selectTaskCommits(commits, { matcher: { jiraKey: 'AIP-114878', childIndex: 99 } }).info
          .reason
      ).toBe('no-matching-commits');
      expect(selectTaskCommits(commits, { matcher, forceBranchScope: true }).info.reason).toBe(
        'requested-branch'
      );
      // Every commit matches -> nothing to narrow, so report the branch scope.
      const all = selectTaskCommits(
        commits.map((commit) => ({
          ...commit,
          subject: `chore(AIP-114878): child 1 ${commit.sha}`,
        })),
        { matcher }
      );
      expect(all.info.reason).toBe('all-commits-match');
      expect(all.commits).toHaveLength(3);
    });
  });

  describe('collectCommitSetDiffs', () => {
    const git = (cwd: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        import('child_process').then(({ execFile }) => {
          execFile('git', args, { cwd }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
        });
      });

    async function commitFile(root: string, file: string, content: string, message: string) {
      await fs.writeFile(path.join(root, file), content);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', message]);
      return (await git(root, ['rev-parse', 'HEAD'])).trim();
    }

    it('diffs only the selected commits', async () => {
      await git(tempDir, ['init']);
      await git(tempDir, ['config', 'user.email', 't@example.com']);
      await git(tempDir, ['config', 'user.name', 't']);
      await commitFile(tempDir, 'base.txt', 'base\n', 'chore: init');

      const taskA = await commitFile(tempDir, 'a.txt', 'a\n', 'feat(AIP-1): task A #AIP-1');
      await commitFile(tempDir, 'b.txt', 'b\n', 'feat(AIP-2): task B #AIP-2');

      const result = await collectCommitSetDiffs(tempDir, [taskA]);

      expect(result.files.map((file) => file.path)).toEqual(['a.txt']);
      expect(result.diff).toContain('diff --git a/a.txt b/a.txt');
      expect(result.diff).not.toContain('b.txt');
      expect(result.hasChanges).toBe(true);
    });

    it('collects a commit file list once across several commits', async () => {
      await git(tempDir, ['init']);
      await git(tempDir, ['config', 'user.email', 't@example.com']);
      await git(tempDir, ['config', 'user.name', 't']);
      const first = await commitFile(tempDir, 'a.txt', 'one\n', 'feat(AIP-1): part 1');
      const second = await commitFile(tempDir, 'a.txt', 'two\n', 'feat(AIP-1): part 2');

      const result = await collectCommitSetDiffs(tempDir, [second, first]);

      expect(result.files.map((file) => file.path)).toEqual(['a.txt']);
      // Both commits changed the file, so two diff blocks are returned.
      expect(result.diff.match(/diff --git a\/a\.txt/g)).toHaveLength(2);
    });

    it('handles root commits without a parent', async () => {
      await git(tempDir, ['init']);
      await git(tempDir, ['config', 'user.email', 't@example.com']);
      await git(tempDir, ['config', 'user.name', 't']);
      const root = await commitFile(tempDir, 'first.txt', 'first\n', 'feat(AIP-1): root');

      const result = await collectCommitSetDiffs(tempDir, [root]);

      expect(result.files.map((file) => file.path)).toEqual(['first.txt']);
      expect(result.diff).toContain('diff --git a/first.txt b/first.txt');
    });

    it('returns submodule content only when asked to', async () => {
      await git(tempDir, ['init']);
      await git(tempDir, ['config', 'user.email', 't@example.com']);
      await git(tempDir, ['config', 'user.name', 't']);
      await commitFile(tempDir, 'root.txt', 'root\n', 'chore: init');

      const subDir = path.join(tempDir, 'sub');
      await fs.mkdir(subDir);
      await git(subDir, ['init']);
      await git(subDir, ['config', 'user.email', 't@example.com']);
      await git(subDir, ['config', 'user.name', 't']);
      await commitFile(subDir, 'inner.txt', 'inner\n', 'sub init');
      await git(tempDir, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--name',
        'sub',
        '--',
        './sub',
        'sub',
      ]);
      await git(tempDir, ['commit', '-m', 'chore: add submodule']);

      await fs.writeFile(path.join(subDir, 'inner.txt'), 'inner changed\n');
      await git(subDir, ['add', '.']);
      await git(subDir, ['commit', '-m', 'sub work']);
      await git(tempDir, ['add', '.']);
      await git(tempDir, ['commit', '-m', 'chore(AIP-1): bump sub (child 1)']);
      const bump = (await git(tempDir, ['rev-parse', 'HEAD'])).trim();

      const full = await collectCommitSetDiffs(tempDir, [bump]);
      expect(full.files.some((file) => file.path === 'sub/inner.txt')).toBe(true);
      expect(full.summaries[0]).toMatchObject({ path: 'sub', status: 'modified', filesChanged: 1 });
      expect(full.diff).toContain('diff --git a/sub/inner.txt b/sub/inner.txt');

      const onlySubmodules = await collectCommitSetDiffs(tempDir, [bump], { submodulesOnly: true });
      expect(onlySubmodules.files.every((file) => file.path.startsWith('sub/'))).toBe(true);
      expect(onlySubmodules.diff).not.toContain('diff --git a/root.txt');
      expect(onlySubmodules.summaries).toHaveLength(1);
    });
  });

  describe('nested worktree exclusion', () => {
    const execIn = (cwd: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        import('child_process').then(({ execFile }) => {
          execFile('git', args, { cwd }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
        });
      });

    it('derives prefixes for worktrees nested inside the project', () => {
      const prefixes = worktreePrefixesFromList('/repo', [
        '/repo',
        '/repo/.worktrees/aip-1',
        '/repo/.worktrees/nested/deep',
        '/elsewhere/tree',
      ]);

      expect(prefixes).toEqual(['.worktrees/aip-1', '.worktrees/nested/deep']);
    });

    it('treats paths under .worktrees as nested worktree content', () => {
      expect(isInsideNestedWorktree('.worktrees', [])).toBe(true);
      expect(isInsideNestedWorktree('.worktrees/aip-1/src/a.ts', [])).toBe(true);
      expect(isInsideNestedWorktree('.worktrees-other/src/a.ts', [])).toBe(false);
      expect(isInsideNestedWorktree('src/a.ts', ['.worktrees/aip-1'])).toBe(false);
      expect(isInsideNestedWorktree('.worktrees/aip-1', ['.worktrees/aip-1'])).toBe(true);
    });

    it('does not list files from a nested worktree directory as new files', async () => {
      await fs.writeFile(path.join(tempDir, 'tracked.txt'), 'tracked\n');
      await execIn(tempDir, ['init']);
      await execIn(tempDir, ['config', 'user.email', 't@example.com']);
      await execIn(tempDir, ['config', 'user.name', 't']);
      await execIn(tempDir, ['add', '.']);
      await execIn(tempDir, ['commit', '-m', 'init']);

      // Simulate another worktree parked inside the project directory, plus a real
      // untracked file that must still be reported.
      const otherWorktree = path.join(tempDir, '.worktrees', 'aip-1');
      await fs.mkdir(path.join(otherWorktree, 'src'), { recursive: true });
      await fs.writeFile(path.join(otherWorktree, 'src', 'foreign.ts'), 'foreign\n');
      await fs.writeFile(path.join(tempDir, 'new.txt'), 'new\n');

      const result = await getGitRepositoryDiffs(tempDir);

      expect(result.files.map((file) => file.path)).toContain('new.txt');
      expect(result.files.some((file) => file.path.startsWith('.worktrees'))).toBe(false);
      expect(result.diff).not.toContain('foreign.ts');
    });
  });
});
