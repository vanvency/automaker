# Git Workflow: Branch, Commit, Push, and Pull Request

This document outlines the standard workflow for creating a branch, committing changes, pushing to remote, and creating a pull request.

## Prerequisites

- Git installed and configured
- GitHub CLI (`gh`) installed (optional, but recommended for PR creation)
- Access to the repository
- Authentication configured (SSH keys or GitHub CLI authentication)

## Step-by-Step Workflow

### 1. Check Current Status

First, check what changes exist in your working directory:

```bash
git status
```

This shows:

- Modified files
- Deleted files
- Untracked files
- Current branch

### 2. Create a New Branch

Create and switch to a new branch for your changes:

```bash
git checkout -b <branch-name>
```

**Branch naming conventions:**

- `feature/` - for new features
- `fix/` or `bugfix/` - for bug fixes
- `refactor/` - for code refactoring
- `docs/` - for documentation changes
- `chore/` - for maintenance tasks

**Example:**

```bash
git checkout -b refactor/monorepo-restructure
```

### 3. Stage Changes

Stage all changes (including deletions and new files):

```bash
git add -A
```

Or stage specific files:

```bash
git add <file1> <file2>
```

### 4. Commit Changes

Create a commit with a descriptive message:

```bash
git commit -m "type: descriptive commit message"
```

**Commit message conventions:**

- Use conventional commits format: `type: description`
- Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `style`
- Keep messages concise but descriptive

**Example:**

```bash
git commit -m "refactor: restructure project to monorepo with apps directory"
```

### 5. Push Branch to Remote

Push your branch to the remote repository:

```bash
git push -u origin <branch-name>
```

The `-u` flag sets up tracking so future pushes can use `git push` without specifying the branch.

**Example:**

```bash
git push -u origin refactor/monorepo-restructure
```

### 6. Create Pull Request

> **Always open pull requests as drafts.** A draft cannot be merged until someone
> explicitly marks it ready for review, which prevents accidental merges. Every
> example below uses `--draft`; do not drop that flag.

#### Option A: Using GitHub CLI (Recommended)

If you have GitHub CLI installed:

```bash
gh pr create --draft --title "Your PR Title" --body "Description of changes"
```

To open in browser for review before creating:

```bash
gh pr create --draft --title "Your PR Title" --body "Description" --web
```

#### Option B: Using GitHub Web Interface

After pushing, GitHub will provide a URL in the terminal output:

```
remote: Create a pull request for '<branch-name>' on GitHub by visiting:
remote:      https://github.com/<org>/<repo>/pull/new/<branch-name>
```

Visit that URL to create the PR through the web interface.

#### Option C: Manual PR Creation

1. Go to your repository on GitHub
2. Click "Pull requests" tab
3. Click "New pull request"
4. Select your branch as the source
5. Select the target branch (usually `main` or `master`)
6. Fill in title and description
7. Click "Create pull request"

## Complete Example Workflow

```bash
# 1. Check status
git status

# 2. Create branch
git checkout -b feature/add-new-component

# 3. Make your changes (edit files, etc.)

# 4. Stage changes
git add -A

# 5. Commit
git commit -m "feat: add new user dashboard component"

# 6. Push
git push -u origin feature/add-new-component

# 7. Create PR
gh pr create --draft --title "feat: add new user dashboard component" --body "Implements new dashboard component with user statistics and activity feed."
```

## Handling Additional Changes

If you need to make more changes after pushing:

```bash
# Make your changes
git add -A
git commit -m "fix: address review feedback"
git push
```

The PR will automatically update with the new commits.

## Troubleshooting

### Branch already exists

```bash
git checkout <existing-branch-name>
```

### Need to update from main before creating PR

```bash
git checkout main
git pull origin main
git checkout <your-branch>
git merge main
# Resolve conflicts if any
git push
```

### PR creation fails

- Ensure branch is pushed: `git push -u origin <branch-name>`
- Check GitHub CLI authentication: `gh auth status`
- Verify repository access permissions
- Try creating PR via web interface instead

## Best Practices

1. **Keep branches focused**: One branch = one feature/fix
2. **Write clear commit messages**: Help reviewers understand changes
3. **Keep PRs small**: Easier to review and merge
4. **Update before creating PR**: Merge latest `main` into your branch
5. **Add tests**: Include tests for new features
6. **Update documentation**: Keep docs in sync with code changes
7. **Request reviews**: Tag relevant team members for review

## Quick Reference Commands

```bash
# Status check
git status

# Create branch
git checkout -b <branch-name>

# Stage all changes
git add -A

# Commit
git commit -m "type: message"

# Push
git push -u origin <branch-name>

# Create PR (GitHub CLI) - always a draft, never ready-for-review by default
gh pr create --draft --title "Title" --body "Description"

# View PR
gh pr view

# List PRs
gh pr list
```
