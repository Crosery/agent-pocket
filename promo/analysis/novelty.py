import sys, numpy as np, librosa
y, sr = librosa.load(sys.argv[1], sr=22050, mono=True)
P0, off = 60/125.7, 0.028
hop=256
S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
f = librosa.fft_frequencies(sr=sr, n_fft=2048)
t = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=hop)
bands = {'low': (20,150), 'mid': (150,2000), 'high': (4000,11000)}
E = {k: 20*np.log10(np.sqrt((S[(f>=a)&(f<b)]**2).mean(0))+1e-6) for k,(a,b) in bands.items()}
nb = int((len(y)/sr-off)/P0)
print('beat  time   low   mid  high')
for i in range(nb):
    a = off + i*P0; m = (t>=a)&(t<a+P0)
    print('%3d %6.2f %5.1f %5.1f %5.1f' % (i, a, E['low'][m].mean(), E['mid'][m].mean(), E['high'][m].mean()))
