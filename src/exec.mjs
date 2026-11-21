// Process execution with hard boundaries: own process group, timeout, log file.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const KILL_GRACE_MS = 8000;

export function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a command, streaming output to `logPath`. Resolves (never rejects) with
 * { code, signal, timedOut, durationMs, stdout }.
 */
export function runProcess({ command, args = [], cwd, env, timeoutMs = 15 * 60 * 1000, logPath, nice = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = fs.createWriteStream(logPath, { flags: 'a' });
    out.write(`\n$ ${command} ${args.join(' ')}\n`);

    const realCommand = nice ? '/usr/bin/nice' : command;
    const realArgs = nice ? ['-n', '10', command, ...args] : args;

    let child;
    try {
      child = spawn(realCommand, realArgs, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      out.end(`spawn failed: ${err.message}\n`);
      resolve({ code: 127, signal: null, timedOut: false, durationMs: 0, stdout: '' });
      return;
    }

    let stdout = '';
    let timedOut = false;
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      out.write(`\n[stewie] timeout after ${Math.round(timeoutMs / 1000)}s — terminating\n`);
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      out.write(d);
    });
    child.stderr.on('data', (d) => out.write(d));

    const finish = (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out.end(`\n[stewie] exit=${code ?? 'null'} signal=${signal ?? 'null'} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
      resolve({ code: code ?? 1, signal, timedOut, durationMs: Date.now() - started, stdout });
    };

    child.on('error', (err) => {
      out.write(`\n[stewie] spawn error: ${err.message}\n`);
    });
    child.on('close', finish);
  });
}

export function shellCommand(command) {
  return { command: '/bin/zsh', args: ['-lc', command] };
}
