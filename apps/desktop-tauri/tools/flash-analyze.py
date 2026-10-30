#!/usr/bin/env python3
"""#310: analyse a native-resize recording of the island (probe scene native_resize_flash_scene).
Usage: flash-analyze.py <tag> <runtime-probe dir>. Crops each frame of the X-server recording to the window
rectangle sampled at that instant and reports frames where a big window is entirely blank (transparent = black
on a bare Xvfb). A pre-compositor view: it shows what the X window holds, not what a Wayland compositor does."""
import json, sys, subprocess, glob, os, shutil
import numpy as np
from PIL import Image


def main(argv):
    if len(argv) != 3:
        print('usage: flash-analyze.py <tag> <runtime-probe dir>', file=sys.stderr)
        return 64
    tag, root = argv[1], argv[2]
    log = f'{root}/probe-flash-{tag}.log'
    video = f'{root}/flash/flash-{tag}.mkv'
    for needed in (log, video):
        if not os.path.isfile(needed):
            print(f'missing input: {needed}', file=sys.stderr)
            return 66
    try:
        d = None
        with open(log) as handle:
            for l in handle:
                if '"step":"flash_timeline"' in l:
                    d = json.loads(l)
        if d is None:
            print('no flash_timeline line in the log', file=sys.stderr)
            return 65
        t0=d['record_start_ms']; geo=d['window_geometry']; host=d['host']
        shutil.rmtree('/tmp/flf',ignore_errors=True); os.makedirs('/tmp/flf')
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',video,'-vsync','0','/tmp/flf/f%04d.png'],check=True)
        frames=sorted(glob.glob('/tmp/flf/f*.png'))
        fps=60.0
        # the video's first frame is at roughly t0+offset; calibrate with the first window geometry sample time
        BEIGE=np.array([0xd8,0xc9,0xa3])
        def geom_at(ms):
            best=None
            for g in geo:
                if g[0]<=ms: best=g
                else: break
            return best
        rows=[]; prev=None
        for i,f in enumerate(frames):
            ms=t0+ i*1000/fps
            g=geom_at(ms)
            if not g: rows.append((i,None)); continue
            _,x,y,w,h=g
            a=np.asarray(Image.open(f).convert('RGB')).astype(int)[y:y+h, x:x+w]
            if a.size==0: rows.append((i,None)); continue
            black=(a.sum(axis=2)<30); beige=(np.abs(a-BEIGE).sum(axis=2)<24)
            other=~(black|beige)
            white=(a.min(axis=2)>235)
            rows.append((i,dict(ms=int(i*1000/fps),w=int(w),h=int(h),black=float(black.mean()),beige=float(beige.mean()),other=float(other.mean()),white=float(white.mean()))))
        json.dump(rows,open(f'/tmp/flf/rows-{tag}.json','w'))
        print('frames',len(frames),'geometry samples',len(geo))
        bad=[r for r in rows if r[1] and (r[1]['black']>0.97 and r[1]['w']>100)]
        print('frames where a big window is ALL black (blank frame):',len(bad), [ (r[0],r[1]['ms'],r[1]['w'],r[1]['h']) for r in bad][:20])
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        print(f'analysis failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
