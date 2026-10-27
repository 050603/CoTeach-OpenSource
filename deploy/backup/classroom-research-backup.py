#!/usr/bin/env python3
"""Scoped classroom research archives, encrypted offsite copies and one-session sealing."""

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

PROJECT = Path(__file__).resolve().parents[2]
ROOT = Path(os.environ.get('OPENPBL_RESEARCH_BACKUP_DIR', str(PROJECT / '.openpbl-data/classroom-backup'))).resolve()
SESSION_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}')
spec = importlib.util.spec_from_file_location('local_backup', Path(__file__).with_name('local-backup.py'))
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    local.write_json(path, value)


def config_values():
    # These four non-secret values do not require evaluating a shell/.env file.
    allowed = {'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_REGION', 'MANUAL_BACKUP_OFFERING_ID'}
    result = {}
    for line in (PROJECT / 'deploy/.deploy.env').read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and key in allowed:
            result[key] = value.strip().strip('"\'')
    return result


def session_path(name):
    if not SESSION_PATTERN.fullmatch(name):
        raise ValueError('Invalid session label')
    return ROOT / 'sessions' / (name + '.json')


def load_session(name):
    value = json.loads(session_path(name).read_text())
    uuid.UUID(value['offeringId'])
    return value


@contextlib.contextmanager
def locked(name='cloud'):
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT / (name + '.lock')).open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def scope_sql(offering_id):
    offering_id = str(uuid.UUID(offering_id))
    return f'''WITH e AS (SELECT * FROM "Enrollment" WHERE "offeringId"='{offering_id}'),
      a AS (SELECT a.* FROM "Activity" a JOIN "Chapter" c ON c.id=a."chapterId" WHERE c."offeringId"='{offering_id}'),
      i AS (SELECT * FROM "ClassroomInstance" WHERE "activityId" IN (SELECT id FROM a)),
      p AS (SELECT * FROM "ClassroomParticipation" WHERE "instanceId" IN (SELECT id FROM i) AND "enrollmentId" IN (SELECT id FROM e)),
      v AS (SELECT * FROM "ClassroomTemplateVersion" WHERE id IN (SELECT "templateVersionId" FROM i)),
      g AS (SELECT * FROM "ProjectGroup" WHERE "offeringId"='{offering_id}'),
      cv AS (SELECT c.* FROM "AiConversation" c WHERE (c."offeringId"='{offering_id}' OR (c."offeringId" IS NULL AND c."participationId" IN (SELECT id FROM p)))
        AND c."userId" IN (SELECT "userId" FROM e)
        AND (c."participationId" IS NULL OR EXISTS(SELECT 1 FROM p JOIN e ON e.id=p."enrollmentId" WHERE p.id=c."participationId" AND e."userId"=c."userId"))),
      ar AS (SELECT * FROM "Artifact" WHERE "participationId" IN (SELECT id FROM p)),
      av AS (SELECT * FROM "ArtifactVersion" WHERE "artifactId" IN (SELECT id FROM ar)),
      tasks AS (SELECT * FROM "AiTask" WHERE ("offeringId"='{offering_id}' OR ("offeringId" IS NULL AND "conversationId" IN (SELECT id FROM cv))) AND ("conversationId" IS NULL OR "conversationId" IN (SELECT id FROM cv))),
      assignments AS (SELECT * FROM "ExperimentAssessmentAssignment" WHERE "instanceId" IN (SELECT id FROM i) AND "enrollmentId" IN (SELECT id FROM e)),
      discussions AS (SELECT * FROM "PublicDiscussionSession" WHERE "classroomInstanceId" IN (SELECT id FROM i))'''


def selectors(offering_id):
    o = str(uuid.UUID(offering_id))
    return {
        'CourseOffering': f'''SELECT * FROM "CourseOffering" WHERE id='{o}' ''',
        'Enrollment': 'SELECT * FROM e',
        'User': '''SELECT u.* FROM "User" u WHERE u.id IN (SELECT "userId" FROM e) AND u.role='STUDENT' ''',
        'CourseTeacher': f'''SELECT * FROM "CourseTeacher" WHERE "offeringId"='{o}' ''',
        'Chapter': f'''SELECT * FROM "Chapter" WHERE "offeringId"='{o}' ''',
        'Activity': 'SELECT * FROM a',
        'ActivityProgress': '''SELECT * FROM "ActivityProgress" WHERE "enrollmentId" IN (SELECT id FROM e) AND "activityId" IN (SELECT id FROM a)''',
        'ActivitySubmission': '''SELECT * FROM "ActivitySubmission" WHERE "enrollmentId" IN (SELECT id FROM e) AND "activityId" IN (SELECT id FROM a)''',
        'ClassroomInstance': 'SELECT * FROM i',
        'ClassroomTemplateVersion': 'SELECT * FROM v',
        'ClassroomTemplate': '''SELECT * FROM "ClassroomTemplate" WHERE id IN (SELECT "templateId" FROM v)''',
        'ClassroomParticipation': 'SELECT * FROM p',
        'StudentProjectWorkspace': '''SELECT * FROM "StudentProjectWorkspace" WHERE "participationId" IN (SELECT id FROM p)''',
        'ClassroomSubmission': '''SELECT * FROM "ClassroomSubmission" WHERE "participationId" IN (SELECT id FROM p)''',
        'ExperimentAssessmentAssignment': 'SELECT * FROM assignments',
        'ExperimentAssessmentSubmission': '''SELECT * FROM "ExperimentAssessmentSubmission" WHERE "assignmentId" IN (SELECT id FROM assignments) AND "instanceId" IN (SELECT id FROM i) AND "enrollmentId" IN (SELECT id FROM e)''',
        'ExperimentAssessmentDraft': '''SELECT * FROM "ExperimentAssessmentDraft" WHERE "assignmentId" IN (SELECT id FROM assignments)''',
        'AiConversation': 'SELECT * FROM cv',
        'AiMessage': '''SELECT * FROM "AiMessage" WHERE "conversationId" IN (SELECT id FROM cv)''',
        'AiTask': 'SELECT * FROM tasks',
        'AiTaskRequestAlias': '''SELECT * FROM "AiTaskRequestAlias" WHERE "participationId" IN (SELECT id FROM p) AND "taskId" IN (SELECT id FROM tasks)''',
        'AiActionConfirmation': f'''SELECT * FROM "AiActionConfirmation" WHERE "offeringId"='{o}' AND ("taskId" IS NULL OR "taskId" IN (SELECT id FROM tasks))''',
        'Artifact': 'SELECT * FROM ar',
        'ArtifactVersion': 'SELECT * FROM av',
        'ShowcasePresentation': '''SELECT * FROM "ShowcasePresentation" WHERE "participationId" IN (SELECT id FROM p) AND "artifactId" IN (SELECT id FROM ar)''',
        'Reflection': '''SELECT * FROM "Reflection" WHERE "participationId" IN (SELECT id FROM p)''',
        'Evaluation': '''SELECT * FROM "Evaluation" WHERE "participationId" IN (SELECT id FROM p)''',
        'ProjectGroup': 'SELECT * FROM g',
        'GroupMember': '''SELECT * FROM "GroupMember" WHERE "groupId" IN (SELECT id FROM g) AND ("participationId" IS NULL OR "participationId" IN (SELECT id FROM p))''',
        'WorkPlanItem': '''SELECT * FROM "WorkPlanItem" WHERE "groupId" IN (SELECT id FROM g)''',
        'GroupBoard': '''SELECT * FROM "GroupBoard" WHERE "groupId" IN (SELECT id FROM g)''',
        'PublicDiscussionSession': 'SELECT * FROM discussions',
        'PublicDiscussionTurn': '''SELECT * FROM "PublicDiscussionTurn" WHERE "sessionId" IN (SELECT id FROM discussions)''',
        'Resource': f'''SELECT * FROM "Resource" WHERE "offeringId"='{o}' ''',
        'FileAsset': f'''SELECT id,"storageKey","originalName","mimeType",size,sha256,"assetRole","backupPolicy","sourceAssetId","offeringId","createdAt","updatedAt","deletedAt" FROM "FileAsset" WHERE "offeringId"='{o}' OR id IN (SELECT "fileAssetId" FROM av) OR id IN (SELECT "fileAssetId" FROM "Resource" WHERE "offeringId"='{o}')''',
        'LearningEvent': f'''SELECT * FROM "LearningEvent" WHERE "offeringId"='{o}' ''',
        'AiInteractionEvent': f'''SELECT * FROM "AiInteractionEvent" WHERE "offeringId"='{o}' ''',
        'DomainEvent': f'''SELECT * FROM "DomainEvent" WHERE "offeringId"='{o}' ''',
        'AiSupportRecord': f'''SELECT * FROM "AiSupportRecord" WHERE "offeringId"='{o}' ''',
        'LearningSignal': f'''SELECT * FROM "LearningSignal" WHERE "offeringId"='{o}' ''',
        'Intervention': f'''SELECT * FROM "Intervention" WHERE "offeringId"='{o}' ''',
        'TeacherAgentDirective': f'''SELECT * FROM "TeacherAgentDirective" WHERE "offeringId"='{o}' ''',
    }


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def capture_outbox():
    directory = Path(os.environ.get('AI_AUDIT_OUTBOX_DIR', str(PROJECT / '.openpbl-data/ai-audit-outbox')))
    batches = []
    for parent in (directory, directory / 'quarantine'):
        if not parent.exists():
            continue
        for filename in sorted(parent.glob('*.json')):
            try:
                events = json.loads(filename.read_text())
                if not isinstance(events, list):
                    raise ValueError('Invalid audit batch')
                batches.append((parent.name == 'quarantine', filename.name, events))
            except FileNotFoundError:
                pass  # A consumer already committed the batch, before our DB snapshot.
    return batches


def archive_diagnostics(directory):
    """Count concrete association failures without logging student content."""
    def rows(table):
        with (directory / (table + '.jsonl')).open() as handle:
            yield from (json.loads(line) for line in handle)
    enrollments = {row['id']: row for row in rows('Enrollment')}
    participations = {row['id']: row for row in rows('ClassroomParticipation')}
    conversations = {row['id']: row for row in rows('AiConversation')}
    messages = {row['id']: row['conversationId'] for row in rows('AiMessage')}
    issues = {'researchKeyMismatch': 0, 'missingStudentResearchKey': 0,
              'messageReferenceUnresolved': 0, 'repeatedMessageFacts': 0,
              'suspectedRepeatedInlineContent': 0}
    canonical_facts, inline = set(), set()
    for table in ('ActivitySubmission', 'ExperimentAssessmentSubmission', 'LearningEvent', 'AiInteractionEvent', 'DomainEvent'):
        for row in rows(table):
            participation = participations.get(row.get('participationId'), {})
            enrollment = enrollments.get(row.get('enrollmentId') or participation.get('enrollmentId'))
            if enrollment:
                if not row.get('researchKey'):
                    issues['missingStudentResearchKey'] += 1
                elif row['researchKey'] != enrollment['researchKey']:
                    issues['researchKeyMismatch'] += 1
            if table != 'AiInteractionEvent':
                continue
            payload = row.get('payload') if isinstance(row.get('payload'), dict) else {}
            detail = payload.get('detail') if isinstance(payload.get('detail'), dict) else {}
            if payload.get('schemaVersion') == 2 and detail.get('contentRef') == 'AiMessage':
                message_id = detail.get('messageId')
                conversation = conversations.get(row.get('conversationId'), {})
                if (messages.get(message_id) != row.get('conversationId') or not conversation
                        or conversation.get('userId') != row.get('userId')):
                    issues['messageReferenceUnresolved'] += 1
                key = (message_id, row.get('eventType'), row.get('actor'))
                issues['repeatedMessageFacts'] += int(key in canonical_facts)
                canonical_facts.add(key)
            elif row.get('content'):
                # Repeated wording may be a deliberate new question. This is
                # a diagnostic only, never a deletion or attempt-count rule.
                key = hashlib.sha256(canonical([row.get('conversationId'), row.get('userId'), row.get('actor'), row.get('eventType'), row['content']]).encode()).hexdigest()
                issues['suspectedRepeatedInlineContent'] += int(key in inline)
                inline.add(key)
    return {'issues': issues, 'countsAreNotGrades': True,
            'absenceDoesNotProveNonParticipation': True, 'browserUnsentData': 'not observable by server'}


def export_package(session):
    """Every database record is read from one repeatable-read, read-only transaction."""
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    session_path(session['session'])  # Validate before using the label as a directory.
    packages = ROOT / 'packages' / session['session']
    packages.mkdir(parents=True, exist_ok=True)
    target = Path(tempfile.mkdtemp(prefix='.partial-', dir=packages))
    tables = selectors(session['offeringId'])
    outbox = capture_outbox()  # Before DB snapshot: consumer cannot create a gap.
    handles = {}
    counts = {name: 0 for name in tables}
    instance_ids = set()
    pending = 0
    try:
        for name in tables:
            handles[name] = (target / (name + '.jsonl')).open('w')
        with tempfile.TemporaryFile(mode='w+') as query, tempfile.TemporaryFile(mode='w+') as errors:
            query.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='45s'; SET LOCAL lock_timeout='2s';\n")
            query.write("SELECT json_build_object('table','_snapshot','row',json_build_object('at',transaction_timestamp(),'snapshot',txid_current_snapshot()));\n")
            for name, select in tables.items():
                query.write(scope_sql(session['offeringId']) + f" SELECT json_build_object('table','{name}','row',to_jsonb(t)) FROM ({select}) t ORDER BY to_jsonb(t)->>'id',to_jsonb(t)::text;\n")
            query.write('COMMIT;\n')
            query.seek(0)
            process = subprocess.Popen(local.pg_args(), stdin=query, stdout=subprocess.PIPE, stderr=errors, text=True)
            snapshot = None
            for line in process.stdout:
                envelope = json.loads(line)
                name, row = envelope['table'], envelope['row']
                if name == '_snapshot':
                    snapshot = row
                    continue
                if name not in handles:
                    raise RuntimeError('Unexpected database result')
                handles[name].write(canonical(row) + '\n')
                counts[name] += 1
                if name == 'ClassroomInstance':
                    instance_ids.add(row['id'])
                if name == 'AiTask' and row['status'] in ('PENDING', 'RUNNING'):
                    pending += 1
            if process.wait() != 0 or not snapshot:
                raise RuntimeError('Consistent research export failed; database details suppressed')
        for handle in handles.values():
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()
        handles.clear()
        if counts['CourseOffering'] != 1:
            raise RuntimeError('Formal offering not found')
        audit = []
        quarantined = 0
        for quarantine, name, events in outbox:
            scoped = [event for event in events if isinstance(event, dict) and event.get('courseId') in instance_ids]
            if scoped:
                audit.append({'batch': name, 'quarantined': quarantine, 'events': scoped})
                quarantined += int(quarantine)
        (target / 'AuditOutbox.jsonl').write_text(''.join(canonical(row) + '\n' for row in audit))
        with (target / 'AuditOutbox.jsonl').open('r') as handle:
            os.fsync(handle.fileno())
        counts['AuditOutbox'] = len(audit)
        files = {path.name: {'sha256': local.sha256(path), 'bytes': path.stat().st_size, 'records': counts[path.stem]}
                 for path in sorted(target.glob('*.jsonl'))}
        digest = hashlib.sha256(canonical(files).encode()).hexdigest()
        manifest = {'formatVersion': 1, 'kind': 'scoped-classroom-research', 'session': session['session'],
                    'offeringId': session['offeringId'], 'snapshot': snapshot, 'dataDigest': digest, 'files': files,
                    'counts': counts, 'diagnostics': archive_diagnostics(target),
                    'pendingTasks': pending, 'pendingAuditBatches': len(audit), 'quarantinedAuditBatches': quarantined,
                    'fullSystemRecovery': False, 'containsStudentAccountHashes': True,
                    'excluded': ['attachment/media bytes', 'textbook vectors', 'source code', 'system/provider credentials'],
                    'analysis': {'rawRecordsPreserved': True, 'messageTable': 'AiMessage', 'eventsAreNotMessageCounts': True,
                                 'currentProjections': ['ActivityProgress', 'StudentProjectWorkspace', 'ClassroomSubmission', 'Reflection', 'Evaluation'],
                                 'immutableEvidence': ['ActivitySubmission', 'ExperimentAssessmentSubmission', 'ArtifactVersion', 'DomainEvent']}}
        write_json(target / 'manifest.json', manifest)
        verify_package(target)
        destination = packages / digest
        if destination.exists():
            manifest = verify_package(destination)
            shutil.rmtree(target)
        else:
            # Reuse unchanged per-table files across local research packages.
            previous_path = ROOT / 'status' / (session['session'] + '-package.json')
            if previous_path.exists():
                previous_digest = json.loads(previous_path.read_text()).get('dataDigest', '')
                if re.fullmatch(r'[0-9a-f]{64}', previous_digest):
                    previous = packages / previous_digest
                    if previous.is_dir():
                        old = verify_package(previous)
                        for name, item in files.items():
                            if old['files'].get(name) == item:
                                (target / name).unlink()
                                os.link(previous / name, target / name)
            target.rename(destination)
            directory = os.open(packages, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        write_json(ROOT / 'status' / (session['session'] + '-package.json'), {'dataDigest': digest})
        return destination, manifest
    except BaseException:
        if 'process' in locals() and process.poll() is None:
            process.kill()
            process.wait()
        raise
    finally:
        if 'process' in locals() and process.stdout:
            process.stdout.close()
        for handle in handles.values():
            handle.close()
        if target.exists():
            shutil.rmtree(target)


def verify_package(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest['formatVersion'] != 1 or manifest['kind'] != 'scoped-classroom-research':
        raise RuntimeError('Unsupported research archive')
    expected = set(selectors(manifest['offeringId'])) | {'AuditOutbox'}
    if set(manifest['files']) != {name + '.jsonl' for name in expected}:
        raise RuntimeError('Archive inventory mismatch')
    if {path.name for path in directory.iterdir()} != set(manifest['files']) | {'manifest.json'}:
        raise RuntimeError('Unexpected archive files')
    for name, item in manifest['files'].items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != item['bytes'] or local.sha256(path) != item['sha256']:
            raise RuntimeError('Research file checksum mismatch: ' + name)
        with path.open() as handle:
            records = sum(1 for line in handle if isinstance(json.loads(line), dict))
        if records != item['records'] or records != manifest['counts'][path.stem]:
            raise RuntimeError('Research record count mismatch: ' + name)
    digest = hashlib.sha256(canonical(manifest['files']).encode()).hexdigest()
    if digest != manifest['dataDigest']:
        raise RuntimeError('Research archive digest mismatch')
    return manifest


def restic(args, package=None, check=True):
    config = config_values()
    for key in ('BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET'):
        if not config.get(key):
            raise RuntimeError('Cloud backup configuration missing: ' + key)
    secrets = PROJECT / 'deploy/secrets'
    for name in ('s3_access_key', 's3_secret_key', 'restic_password'):
        if not (secrets / (name + '.txt')).is_file():
            raise RuntimeError('Cloud backup secret missing: ' + name)
    script = '''export AWS_ACCESS_KEY_ID="$(tr -d '\\r\\n' < /run/secrets/s3_access_key.txt)"
export AWS_SECRET_ACCESS_KEY="$(tr -d '\\r\\n' < /run/secrets/s3_secret_key.txt)"
export RESTIC_PASSWORD_FILE=/run/secrets/restic_password.txt
exec restic --cache-dir /backup/cache --limit-upload 2048 --limit-download 4096 -o s3.bucket-lookup=dns -o "s3.region=$AWS_DEFAULT_REGION" "$@"'''
    container = 'openpbl-research-backup-' + uuid.uuid4().hex
    command = ['docker', 'run', '--rm', '--name', container, '--network=host', '--user', f'{os.getuid()}:{os.getgid()}',
               '-v', f'{ROOT}:/backup',
               '-e', 'RESTIC_REPOSITORY=s3:' + config['BACKUP_S3_ENDPOINT'].rstrip('/') + '/' + config['BACKUP_S3_BUCKET'] + '/openpbl-classroom-research',
               '-e', 'AWS_DEFAULT_REGION=' + config.get('BACKUP_S3_REGION', 'oss-cn-beijing')]
    for name in ('s3_access_key', 's3_secret_key', 'restic_password'):
        command += ['-v', f'{secrets / (name + ".txt")}:/run/secrets/{name}.txt:ro']
    if package:
        command += ['-v', f'{package}:/payload:ro']
    command += ['--entrypoint', '/bin/sh', os.environ.get('OPENPBL_BACKUP_IMAGE', 'openpbl-backup:0.1.0'), '-ec', script, 'restic', *args]
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=600)
    finally:
        # Killing a timed-out docker client does not stop its container.
        subprocess.run(['docker', 'rm', '-f', container], capture_output=True, timeout=30)
    if check and result.returncode:
        raise RuntimeError(f'Restic {args[0]} failed (exit {result.returncode}); original data retained')
    return result


def upload_package(session, package, manifest):
    state_path = ROOT / 'status' / (session['session'] + '-cloud.json')
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if previous.get('dataDigest') == manifest['dataDigest'] and previous.get('readbackVerified'):
        return previous
    # No init fallback: authentication/network failures must not create repositories.
    restic(['snapshots', '--json'])
    result = restic(['backup', '/payload', '--host', 'openpbl-classroom', '--tag', session['session'], '--json'], package)
    summaries = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    summary = next((row for row in reversed(summaries) if row.get('message_type') == 'summary'), {})
    snapshot_id = summary.get('snapshot_id')
    if not snapshot_id or not re.fullmatch(r'[0-9a-f]{8,64}', snapshot_id):
        raise RuntimeError('Cloud snapshot receipt missing')
    restored = ROOT / 'readback' / snapshot_id
    restored.mkdir(parents=True, exist_ok=True)
    restic(['restore', snapshot_id, '--target', '/backup/readback/' + snapshot_id, '--verify'])
    verified = verify_package(restored / 'payload')
    if (verified['dataDigest'] != manifest['dataDigest'] or verified['offeringId'] != session['offeringId']
            or verified['session'] != session['session']):
        raise RuntimeError('Cloud readback scope/digest mismatch')
    value = {'session': session['session'], 'offeringId': session['offeringId'], 'snapshotId': snapshot_id,
             'dataDigest': manifest['dataDigest'], 'readbackVerified': True, 'verifiedEpoch': time.time(),
             'databaseSnapshotAt': manifest['snapshot']['at'], 'counts': manifest['counts']}
    write_json(state_path, value)
    shutil.rmtree(restored)
    return value


def backup_session(session):
    package, manifest = export_package(session)
    return upload_package(session, package, manifest), manifest


def retain_partial_snapshot(session, state):
    """Keep a recoverable cutoff copy even when pending work prevents a final seal."""
    try:
        for attempt in range(13):
            checkpoint = json.loads((local.ROOT / 'status/last-success.json').read_text())
            label = session['session'][:80] + '-partial-' + hashlib.sha256(checkpoint['snapshot'].encode()).hexdigest()[:12]
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('local-backup.py')), 'seal',
                                     '--session', label], text=True, capture_output=True, timeout=180)
            if result.returncode == 0:
                sealed = json.loads(result.stdout.strip().splitlines()[-1])
                state.update(provisionalLocalSnapshot=sealed['snapshot'], provisionalSealSession=label,
                             provisionalSnapshotIsFinal=False)
                state.pop('cutoffLocalError', None)
                return
            if 'already holds' not in result.stdout or attempt == 12:
                raise RuntimeError('Unable to retain the latest complete local recovery point')
            time.sleep(5)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        state['cutoffLocalError'] = str(error)


def incomplete_cutoff(session, state, now):
    state.update(state='incomplete', reason='Session deadline reached before the final quiescent seal', checkedEpoch=now)
    path = ROOT / 'status' / (session['session'] + '-session.json')
    write_json(path, state)
    try:
        receipt, manifest = backup_session(session)
        state.update(cutoffCloudSnapshot=receipt['snapshotId'], cutoffCloudVerified=True,
                     pending=manifest['pendingTasks'] + manifest['pendingAuditBatches'], counts=manifest['counts'])
        state.pop('cutoffCloudError', None)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        state['cutoffCloudError'] = str(error)
    # Cloud failure must not prevent local protection. This provisional pin is
    # never presented as proof that all students or queues have finished.
    retain_partial_snapshot(session, state)
    write_json(path, state)
    return state


def session_tick(session, now=None):
    tick_started = time.monotonic()
    now = time.time() if now is None else now
    state_path = ROOT / 'status' / (session['session'] + '-session.json')
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if now < session['protectionStartEpoch'] or state.get('state') == 'sealed':
        return state
    if now >= session['deadlineEpoch']:
        return incomplete_cutoff(session, state, now)
    # Stable observations use the exact same content digest as the offsite package.
    package, manifest = export_package(session)
    pending = manifest['pendingTasks'] + manifest['pendingAuditBatches']
    same = state.get('observedDigest') == manifest['dataDigest']
    stable_since = max(state.get('stableSince', now), session['sealAfterEpoch']) if same and not pending else now
    state.update(observedDigest=manifest['dataDigest'], stableSince=stable_since, pending=pending,
                 checkedEpoch=now, state='protecting', counts=manifest['counts'])
    due = now - state.get('lastCloudAttemptEpoch', 0) >= 899
    sealing = now >= session['sealAfterEpoch'] and not pending and same and now - stable_since >= 299
    if manifest['counts']['ClassroomInstance'] == 0:
        sealing = False
        state['reason'] = 'No formal classroom exists yet'
    elif pending:
        state['reason'] = 'Server tasks or audit batches remain pending'
    else:
        state['reason'] = 'Waiting for post-class stability' if not sealing else 'Verifying final recovery points'
    write_json(state_path, state)
    if due or sealing:
        state['lastCloudAttemptEpoch'] = now
        write_json(state_path, state)
        upload_package(session, package, manifest)
    def deadline_reached():
        if now + time.monotonic() - tick_started < session['deadlineEpoch']:
            return False
        state.update(state='incomplete', reason='Final verification exceeded the session deadline')
        retain_partial_snapshot(session, state)
        write_json(state_path, state)
        return True
    if deadline_reached():
        return state
    if sealing:
        started = time.time()
        subprocess.run([sys.executable, str(Path(__file__).with_name('local-backup.py')), 'backup'], check=True, capture_output=True, timeout=900)
        checkpoint = json.loads((local.ROOT / 'status/last-success.json').read_text())
        if checkpoint['startedEpoch'] < started:
            state['reason'] = 'Local backup lock busy; final archive will retry'
        else:
            # A late submission during either backup invalidates the final seal.
            _, after = export_package(session)
            if deadline_reached():
                return state
            if after['dataDigest'] != manifest['dataDigest'] or after['pendingTasks'] or after['pendingAuditBatches']:
                state.update(reason='Late data arrived; final archive will retry', stableSince=time.time())
            else:
                subprocess.run([sys.executable, str(Path(__file__).with_name('local-backup.py')), 'seal', '--session', session['session'], '--snapshot', checkpoint['snapshot']], check=True, capture_output=True, timeout=120)
                state.update(state='sealed', localSnapshot=checkpoint['snapshot'], cloudDigest=manifest['dataDigest'], sealedEpoch=time.time(),
                             reason='Local pinned snapshot and downloaded cloud research archive verified',
                             browserUnsentData='unknown; only server-received data is sealed')
    write_json(state_path, state)
    return state


def arm_session(args):
    start = dt.datetime.fromisoformat(args.start)
    end = dt.datetime.fromisoformat(args.end)
    if not start.tzinfo or not end.tzinfo or start >= end:
        raise ValueError('Start/end must have explicit timezone and increasing time')
    value = {'session': args.session, 'offeringId': str(uuid.UUID(args.offering)),
             'classStart': start.isoformat(), 'classEnd': end.isoformat(),
             'protectionStartEpoch': start.timestamp() - 900, 'sealAfterEpoch': end.timestamp() + 900,
             'deadlineEpoch': end.timestamp() + 3600}
    path = session_path(args.session)
    if path.exists() and json.loads(path.read_text()) != value:
        raise RuntimeError('Session configuration already exists with different scope or times')
    write_json(path, value)
    state_path = ROOT / 'status' / (args.session + '-session.json')
    if not state_path.exists():
        write_json(state_path, {'state': 'armed', 'checkedEpoch': time.time(), 'reason': 'Waiting for classroom protection window'})
    if args.install_timer:
        install_timer(value)
    return value


def install_timer(session):
    """Install finite calendar entries, with no next-day or daily recurrence."""
    unit = 'openpbl-classroom-backup@' + session['session']
    installed = Path.home() / '.config/systemd/user'
    installed.mkdir(parents=True, exist_ok=True)
    service = (PROJECT / 'deploy/systemd/openpbl-classroom-backup@.service').read_text()
    service = service.replace('%h/OpenPBL/openPBL', str(PROJECT))
    (installed / 'openpbl-classroom-backup@.service').write_text(service)
    zone = dt.timezone(dt.timedelta(hours=8))
    at = session['protectionStartEpoch']
    dates = []
    while at <= session['deadlineEpoch']:
        dates.append('OnCalendar=' + dt.datetime.fromtimestamp(at, zone).strftime('%Y-%m-%d %H:%M:%S') + ' Asia/Shanghai')
        at += 300
    timer = '\n'.join(['[Unit]', 'Description=Finite classroom research backup window ' + session['session'],
                       '[Timer]', *dates, 'AccuracySec=1s', 'Persistent=true', 'Unit=' + unit + '.service',
                       '[Install]', 'WantedBy=timers.target', ''])
    (installed / (unit + '.timer')).write_text(timer)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True, capture_output=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', unit + '.timer'], check=True, capture_output=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('arm', 'export', 'backup', 'tick', 'status', 'verify', 'init-repository'))
    parser.add_argument('--session', default='2026-10-20-formal')
    parser.add_argument('--offering')
    parser.add_argument('--start')
    parser.add_argument('--end')
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--install-timer', action='store_true')
    args = parser.parse_args()
    if args.command == 'verify':
        manifest = verify_package(args.directory)
        print(json.dumps({'verified': True, 'dataDigest': manifest['dataDigest'], 'counts': manifest['counts']}))
        return
    with locked():
        if args.command == 'init-repository':
            probe = restic(['snapshots', '--json'], check=False)
            if probe.returncode == 10:
                restic(['init', '--repository-version', '2'])
            elif probe.returncode:
                raise RuntimeError(f'Repository access failed (exit {probe.returncode}); not initializing')
            print(json.dumps({'repositoryReady': True}))
            return
        if args.command == 'arm':
            result = arm_session(args)
        else:
            session = load_session(args.session)
            if args.command == 'export':
                package, manifest = export_package(session)
                result = {'directory': str(package), 'dataDigest': manifest['dataDigest'], 'counts': manifest['counts']}
            elif args.command == 'backup':
                result, _ = backup_session(session)
            elif args.command == 'tick':
                try:
                    result = session_tick(session)
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                    path = ROOT / 'status' / (session['session'] + '-session.json')
                    state = json.loads(path.read_text()) if path.exists() else {}
                    state.update(lastError=type(error).__name__, lastFailureEpoch=time.time(), reason=str(error))
                    if time.time() >= session['deadlineEpoch']:
                        state['state'] = 'incomplete'
                        retain_partial_snapshot(session, state)
                    write_json(path, state)
                    raise
            else:
                result = {'configuration': session}
                for suffix in ('cloud', 'session'):
                    path = ROOT / 'status' / (args.session + '-' + suffix + '.json')
                    result[suffix] = json.loads(path.read_text()) if path.exists() else None
        print(json.dumps(result, ensure_ascii=False))
        return 1 if args.command == 'tick' and result.get('state') == 'incomplete' else 0


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except BlockingIOError:
        print('A research backup is already running; retry on the next tick.', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Never print subprocess stderr or exported student records.
        print(f'Research backup failed: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
