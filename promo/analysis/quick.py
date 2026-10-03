import sys, numpy as np, librosa
y, sr = librosa.load(sys.argv[1], sr=22050, mono=True)
dur = len(y)/sr
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units='time')
print('dur %.2f tempo %s nbeats %d' % (dur, tempo, len(beats)))
rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
t = librosa.times_like(rms, sr=sr, hop_length=512)
db = 20*np.log10(rms+1e-6)
for s in range(int(dur)+1):
    m = (t>=s)&(t<s+1)
    if m.any(): print('%2d s %6.1f dB %s' % (s, db[m].mean(), '#'*int(max(0,(db[m].mean()+50)))))
print('beats', np.round(beats,2).tolist())
