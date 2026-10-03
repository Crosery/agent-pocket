# Per-second profile: total dB, percussive dB (HPSS), low-band dB, centroid; estimated key.
import sys, numpy as np, librosa
y, sr = librosa.load(sys.argv[1], sr=22050, mono=True)
H, P = librosa.effects.hpss(y)
def db(x):
    r = librosa.feature.rms(y=x, frame_length=2048, hop_length=512)[0]; return 20*np.log10(r+1e-6)
d, dp, dh = db(y), db(P), db(H)
S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
low = 20*np.log10(np.sqrt((S[freqs<150]**2).mean(0))+1e-6)
cent = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
t = librosa.times_like(d, sr=sr, hop_length=512)
for s in range(int(len(y)/sr)+1):
    m=(t>=s)&(t<s+1)
    if m.any(): print('%2d  all %6.1f  perc %6.1f  harm %6.1f  low %6.1f  cent %5.0f' % (s, d[m].mean(), dp[m].mean(), dh[m].mean(), low[m].mean(), cent[m].mean()))
chroma = librosa.feature.chroma_cqt(y=H, sr=sr).mean(1)
maj = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]); mnr = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
names='C C# D D# E F F# G G# A A# B'.split()
sc=[(np.corrcoef(np.roll(maj,k),chroma)[0,1],names[k]+' maj') for k in range(12)]+[(np.corrcoef(np.roll(mnr,k),chroma)[0,1],names[k]+' min') for k in range(12)]
print('key', sorted(sc)[-3:])
