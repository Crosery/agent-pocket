import sys, numpy as np, librosa
y, sr = librosa.load(sys.argv[1], sr=22050, mono=True)
H, P = librosa.effects.hpss(y)
hop=128
o = librosa.onset.onset_strength(y=P, sr=sr, hop_length=hop); o2 = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
o = o/np.percentile(o,99) + o2/np.percentile(o2,99)
ofps = sr/hop; dur=len(y)/sr
def score(Pd, off, a=0, b=dur):
    ts = off + Pd*np.arange(int(dur/Pd)+1); ts = ts[(ts>=a)&(ts<b)]
    idx = np.round(ts*ofps).astype(int); idx = idx[(idx>2)&(idx<len(o)-2)]
    return np.maximum.reduce([o[idx-1],o[idx],o[idx+1]]).mean()
best=(0,0,0)
for bpm in np.arange(60,180,0.05):
    Pd=60/bpm
    for off in np.arange(0,Pd,0.005):
        s=score(Pd,off)
        if s>best[0]: best=(s,bpm,off)
print('best', best)
for mult in [0.5, 1, 2, 2/3, 1.5]:
    bpm=best[1]*mult; Pd=60/bpm
    m=max(score(Pd,off) for off in np.arange(0,Pd,0.005)); print('bpm %.2f score %.3f'%(bpm,m))
print('--- local fits')
for a,b in [(0,9),(9,32.2),(32.2,40),(40,47.6),(10,20),(20,32)]:
    bb=(0,0,0)
    for bpm in np.arange(110,140,0.05):
        Pd=60/bpm
        for off in np.arange(0,Pd,0.004):
            s=score(Pd,off,a,b)
            if s>bb[0]: bb=(s,bpm,off)
    print(a,b,'bpm %.2f off %.3f score %.3f'%(bb[1],bb[2],bb[0]))
