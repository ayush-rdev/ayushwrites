// ─────────────────────────────────────────────
//  GitHub REST API client for the admin page.
//  Talks straight to api.github.com from the
//  browser — no server, no proxy. The token is
//  stored in localStorage and never leaves the
//  browser.
// ─────────────────────────────────────────────

const API = 'https://api.github.com';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** base64 (GitHub contents API) → unicode string, UTF-8 safe */
export function decodeBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class GitHub {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = null;
  }

  async req(method, path, body) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Network error — is your connection up?', 0);
    }

    if (!res.ok) {
      let msg = `GitHub error ${res.status}`;
      try {
        const j = await res.json();
        if (j.message) msg = j.message;
      } catch {
        /* keep the generic message */
      }
      throw new ApiError(msg, res.status);
    }
    // classic tokens report their scopes here; fine-grained tokens omit it
    const scopes = res.headers.get('x-oauth-scopes');
    if (scopes) this.lastScopes = scopes;
    return res.status === 204 ? null : res.json();
  }

  /** who is this token? (also validates it) */
  async me() {
    return this.req('GET', '/user');
  }

  async repoInfo() {
    return this.req('GET', `/repos/${this.owner}/${this.repo}`);
  }

  /** read a UTF-8 text file from the repo, decoded */
  async getTextFile(path) {
    const j = await this.req(
      'GET',
      `/repos/${this.owner}/${this.repo}/contents/${path}`,
    );
    return {
      path,
      sha: j.sha,
      size: j.size,
      content: decodeBase64(j.content),
    };
  }

  async listDir(path) {
    const j = await this.req(
      'GET',
      `/repos/${this.owner}/${this.repo}/contents/${path}`,
    );
    return Array.isArray(j) ? j : [];
  }

  /** most recent Actions workflow run (for deploy status) */
  async latestRun() {
    const j = await this.req(
      'GET',
      `/repos/${this.owner}/${this.repo}/actions/runs?per_page=1&branch=${encodeURIComponent(
        this.branch || 'main',
      )}`,
    );
    return j.workflow_runs?.[0] || null;
  }

  /**
   * Commit a batch of file changes as ONE commit on the default branch.
   * files: [{ path, content, encoding? }] to write (encoding: 'utf-8' | 'base64',
   * default 'utf-8' — use 'base64' for image blobs),
   *        [{ path, delete: true }] to delete.
   * Builds a fresh tree off HEAD, so several files can change atomically
   * (and the existing GitHub Actions workflow deploys on the resulting push).
   */
  async commitFiles(files, message) {
    if (!this.branch) {
      const info = await this.repoInfo();
      this.branch = info.default_branch;
    }
    const branch = this.branch;

    const ref = await this.req(
      'GET',
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${branch}`,
    );
    const headSha = ref.object.sha;
    const head = await this.req(
      'GET',
      `/repos/${this.owner}/${this.repo}/git/commits/${headSha}`,
    );

    const entries = [];
    for (const f of files) {
      if (f.delete) {
        entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      } else {
        const blob = await this.req(
          'POST',
          `/repos/${this.owner}/${this.repo}/git/blobs`,
          { content: f.content, encoding: f.encoding || 'utf-8' },
        );
        entries.push({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        });
      }
    }

    const newTree = await this.req(
      'POST',
      `/repos/${this.owner}/${this.repo}/git/trees`,
      { base_tree: head.tree.sha, tree: entries },
    );

    const commit = await this.req(
      'POST',
      `/repos/${this.owner}/${this.repo}/git/commits`,
      { message, tree: newTree.sha, parents: [headSha] },
    );

    await this.req(
      'PATCH',
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`,
      { sha: commit.sha, force: false },
    );

    return { sha: commit.sha, html_url: commit.html_url };
  }
}
