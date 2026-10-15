#!/usr/bin/env python3
"""Bound one coordinator to fast dispatch tools without restricting its workers.

The actor fields below were verified against desktop Codex 0.162.0-alpha.17.2.
This is a workflow guardrail, not an OS security boundary. Codex hook failures
can fail open; deployment must include a real denied-tool acceptance probe.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
from datetime import datetime, timezone

POLICY = '''本会话是调度席位。你负责理解目标、澄清关键取舍、派单、查看回执、独立验收与回传。实质调查、实现、长测试和浏览器操作必须交给执行者。兼容 Linux 且仓库已配置的代码任务，默认通过 cloud-dispatch submit-json 提交 Codex Cloud；需要 GUI/macOS/本机登录的任务派独立本机 worker，不能退回主脑自己做。派单保留任务来源、范围、验收标准和原聊天回程。云端 READY 只表示待验收；已有独立验收负责人则复用并收取结果，仅无负责人时另派未参与实现的验收者。同一 task_id 只保留一名裁决负责人，在固定快照上重放准确 diff、执行验收、提交签名结论，不重复派验或提交验收结论。主脑不能自己签验收。提交后尽快结束当前回合，等待事件回传；不要循环轮询、长时间等待或自己跑构建。可用 shell 仅为受控 cloud-dispatch 快速命令，使用 shlex.join 等价的单引号格式，不能串接 shell。此限制只针对本主脑会话，子 agent 保留执行工具。'''

FAST_TOOLS = {
    'spawnagent', 'agent', 'followuptask', 'sendmessage', 'listagents', 'interruptagent',
    'collaborationspawnagent', 'collaborationfollowuptask',
    'collaborationsendmessage', 'collaborationlistagents',
    'collaborationinterruptagent',
    'mcpcodexapplistthreads', 'mcpcodexappreadthread',
    'mcpcodexappsendmessagetothread', 'mcpcodexapplistprojects',
    'mcpcodexapplistartifacts', 'mcpcodexappgetusagelimits',
    'mcpcodexappsetthreadreadstate', 'mcpcodexappsetthreadtitle',
    'mcpcodexappautomationupdate', 'mcpcodexappopenincodex',
    'functionsrequestuserinputasync', 'requestuserinputasync',
    'clockcurrtime', 'getgoal', 'updategoal',
}


def normalized(name):
    return re.sub(r'[^a-z0-9]', '', str(name).lower())


def shell_allowed(command, wrapper):
    if not isinstance(command, str) or len(command) > 131072:
        return False
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        return False
    # Requiring canonical quoting makes shell interpolation/command chaining
    # impossible, including inside JSON. No evaluation or shell is used here.
    if command != shlex.join(argv) or len(argv) < 2 or argv[0] != wrapper:
        return False
    action = argv[1]
    if action == 'submit-json' and len(argv) == 3:
        try:
            return isinstance(json.loads(argv[2]), dict)
        except ValueError:
            return False
    if action in {'status', 'ack'} and len(argv) == 3:
        return bool(re.fullmatch(r'[A-Za-z0-9_.:-]{1,192}', argv[2]))
    if action == 'events' and (len(argv) == 2 or
            (len(argv) == 4 and argv[2] == '--after' and argv[3].isdigit())):
        return True
    if action in {'health', 'help'} and len(argv) == 2:
        return True
    return False


def coordinator_tool_allowed(data, config):
    name = normalized(data.get('tool_name'))
    args = data.get('tool_input') or {}
    if not isinstance(args, dict):
        return False, 'tool input is not an object'
    if name in {'bash', 'execcommand', 'functionsexeccommand'}:
        return shell_allowed(args.get('command'), config['wrapper']), 'only the fast dispatcher wrapper is allowed'
    if name in FAST_TOOLS:
        return True, 'coordination tool'
    if name in {'collaborationwaitagent', 'waitagent'}:
        value = args.get('timeout_ms', 30000)
        return isinstance(value, int) and 0 <= value <= 10000, 'worker wait must be at most 10 seconds; return and receive the completion event'
    if name == 'mcpcodexappwaitthreads':
        return args.get('timeoutMs', 120000) == 0, 'use an immediate status snapshot, not a blocking wait'
    if name in {'clockwait', 'clocksleep'}:
        return False, 'do not sleep in the coordinator'
    return False, 'delegate this tool to an execution or independent acceptance worker'


def read_registry(path):
    if not path.exists():
        return {}
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('invalid actor registry')
    return value


def register_child(data, config):
    agent_id, transcript = data.get('agent_id'), data.get('transcript_path')
    if not isinstance(agent_id, str) or not agent_id or not isinstance(transcript, str) or not transcript:
        raise ValueError('SubagentStart is missing verified actor metadata')
    if transcript == config['coordinator_transcript']:
        raise ValueError('child cannot use the coordinator transcript')
    path = Path(config['actor_registry'])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        actors = read_registry(path)
        actors[agent_id] = {'transcript_path': transcript, 'registered_at': now()}
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(actors, sort_keys=True))
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)


def now():
    return datetime.now(timezone.utc).isoformat()


def audit(data, config, decision, reason):
    path = Path(config['audit_log'])
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {key: data.get(key) for key in
             ['session_id', 'turn_id', 'transcript_path', 'hook_event_name',
              'tool_name', 'tool_use_id', 'agent_id']}
    event.update(observed_at=now(), decision=decision, reason=reason)
    command = (data.get('tool_input') or {}).get('command')
    if isinstance(command, str):
        event['command_sha256'] = hashlib.sha256(command.encode()).hexdigest()
    raw = (json.dumps(event, ensure_ascii=False) + '\n').encode()
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        os.write(fd, raw)
    finally:
        os.close(fd)


def deny(reason):
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': '主脑只负责调度。' + reason + ' 请委派给执行者；兼容代码任务默认 Codex Cloud。'}}


def handle(data, config):
    event = data.get('hook_event_name')
    if event == 'SubagentStart':
        register_child(data, config)
        audit(data, config, 'register_worker', 'trusted runtime SubagentStart')
        return None
    if event != 'PreToolUse':
        if event == 'UserPromptSubmit' and data.get('transcript_path') == config['coordinator_transcript']:
            return {'hookSpecificOutput': {'hookEventName': event, 'additionalContext': POLICY}}
        return None
    agent_id, transcript = data.get('agent_id'), data.get('transcript_path')
    if agent_id:
        child = read_registry(Path(config['actor_registry'])).get(agent_id)
        if child and child['transcript_path'] == transcript:
            audit(data, config, 'allow_worker', 'registered independent actor')
            return None
        reason = 'unregistered or mismatched worker identity'
        audit(data, config, 'deny', reason)
        return deny(reason)
    if transcript != config['coordinator_transcript']:
        reason = 'unknown actor within the coordinator session'
        audit(data, config, 'deny', reason)
        return deny(reason)
    allowed, reason = coordinator_tool_allowed(data, config)
    audit(data, config, 'allow_coordinator' if allowed else 'deny', reason)
    return None if allowed else deny(reason)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--thread-id', required=True)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    data = json.load(sys.stdin)
    # Other chats are unaffected even if this coordinator's config is broken.
    if data.get('session_id') != args.thread_id:
        return
    try:
        config = json.loads(Path(args.config).read_text())
        if config.get('thread_id') != args.thread_id:
            raise ValueError('configuration thread identity mismatch')
        output = handle(data, config)
    except Exception as exc:
        # Supported explicit denial avoids Codex's fail-open error handling for
        # a coordinator PreToolUse. Non-tool events remain advisory.
        output = deny('coordinator policy error: ' + type(exc).__name__) if data.get('hook_event_name') == 'PreToolUse' else None
    if output is not None:
        print(json.dumps(output, ensure_ascii=False))


if __name__ == '__main__':
    main()
