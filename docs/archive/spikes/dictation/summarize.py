#!/usr/bin/env python3
"""Turns results/*.json (+ .daemons samples) into the markdown table used in the write-up."""
import glob, json, os, sys

def daemon_peak(path):
    """Peak summed RSS (MB) of the speech daemons during the run, minus the first sample."""
    if not os.path.exists(path):
        return None
    totals, cur = [], 0
    for line in open(path):
        line = line.strip()
        if line == '---':
            totals.append(cur); cur = 0
        elif line:
            cur += int(line.split()[0])
    if not totals:
        return None
    return max(totals) / 1024, totals[0] / 1024

LEAD_IN = 0.5  # make-audio pads every read with exactly 0.5 s of silence before the first word

FIRST_WORD = 'ondine'  # every engine renders it as "On", "On Dean", "Undine"…

def correct(text):
    """A partial counts once its first word starts the script ("on" ⊂ "ondine"); "Yeah." or "Mm." do not."""
    words = ''.join(c if c.isalnum() else ' ' for c in text.lower()).split()
    if not words:
        return False
    w = words[0]
    return any(name.startswith(w) or w.startswith(name) for name in (FIRST_WORD, 'undine'))

def from_speech(sess):
    """Key-down → first correct partial, minus the lead-in. The energy onset detector would fire on the music."""
    if not sess or sess.get('firstPartialFromKeyDown') is None:
        return None
    if sess.get('updateTexts'):
        for t, text in zip(sess['updateTimes'], sess['updateTexts']):
            if correct(text):
                return t - LEAD_IN
        return None
    return sess['firstPartialFromKeyDown'] - LEAD_IN

def cadence(sess):
    """Median gap between update bursts (updates <80 ms apart are one burst), while audio flowed."""
    if not sess:
        return None
    times = sess.get('updateTimes')
    if not times:
        return sess.get('meanUpdateInterval')
    times = [t for t in times if t <= sess['audioSeconds']]
    bursts = []
    for t in times:
        if not bursts or t - bursts[-1][-1] > 0.08:
            bursts.append([t])
        else:
            bursts[-1].append(t)
    gaps = sorted(b[0] - a[0] for a, b in zip(bursts, bursts[1:]))
    return gaps[len(gaps) // 2] if gaps else None

def fmt(v, f='%.2f'):
    return '–' if v is None else f % v

rows = []
pattern = sys.argv[1] if len(sys.argv) > 1 else '*'
for p in sorted(glob.glob(f'results/{pattern}.json')):
    if not p.endswith(('-clean.json', '-quiet.json', '-music.json')) or 'smoke' in p:
        continue
    d = json.load(open(p))
    sess = {s['label'].split(' ')[0]: s for s in d['sessions']}
    first, full = sess.get('first'), sess.get('full')
    dp = daemon_peak(p.replace('.json', '.daemons'))
    hits = full.get('vocabularyHits') if full else None
    got = sum(int(v.split('/')[0]) for v in hits.values()) if hits else None
    exp = sum(int(v.split('/')[1]) for v in hits.values()) if hits else None
    name = os.path.basename(p)[:-5]
    engine, read = name.rsplit('-', 1)
    rows.append([
        engine, read, fmt(d['prepareSeconds']),
        fmt(from_speech(first)) + ' / ' + fmt(from_speech(full)),
        fmt(cadence(full)),
        fmt(first and first['finalLatency']) + ' / ' + fmt(full and full['finalLatency']),
        fmt(full and full.get('wer') and full['wer']['wer'] * 100, '%.1f%%'),
        f'{got}/{exp}' if hits else '–',
        fmt(d['peakFootprintMB'], '%.0f'),
        '–' if not dp or dp[0] < 1 else '%.0f' % dp[0],
    ] + ([d['error']] if d.get('error') else []))
hdr = ['engine', 'read', 'load s', 'first correct partial s (4 s / 88 s utterance)', 'partial cadence s',
       'final after key-up s (4 s / 88 s)', 'WER', 'names', 'helper peak MB', 'speech daemons peak RSS MB']
print('| ' + ' | '.join(hdr) + ' |')
print('|' + '---|' * len(hdr))
for r in sorted(rows, key=lambda r: (r[1], r[0])):
    print('| ' + ' | '.join(r) + ' |')
