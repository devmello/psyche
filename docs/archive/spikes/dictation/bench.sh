#!/bin/zsh
# Spike 03 benchmark driver: every engine on both reads of the script, one process per run so
# peak-footprint numbers do not mix, while sampling the RSS of Apple's out-of-process speech daemons.
#   ENGINES="speech parakeet-eou" INPUTS=clean ./bench.sh
#   COLD=1 ./bench.sh   # kill localspeechrecognition first, to measure Apple's cold path
set -u
cd "${0:A:h}"
B=.build/release/dictation-spike
ENGINES=(${=ENGINES:-speech speech-fast speech-vocab dictation dictation-vocab parakeet-eou parakeet-eou-160 parakeet-tdt whisper-base whisper-base-final whisper-small whisper-small-final whisper-small-final-vocab})
INPUTS=(${=INPUTS:-clean music})
TAG=${TAG:-}
mkdir -p results
for e in $ENGINES; do
  for i in $INPUTS; do
    out=results/$e-$i$TAG
    [[ -n ${COLD:-} ]] && { killall localspeechrecognition 2>/dev/null; sleep 2; }
    ( while true; do ps -axo rss=,comm= | grep -E 'localspeechrecognition|embeddedspeech' | sed 's#/.*/##'; echo ---; sleep 0.25; done ) > $out.daemons &
    sampler=$!
    $B run --engine $e --input audio/$i.wav --script script.txt --out $out.json 2> $out.log
    kill $sampler
    print -- "$e/$i done: $(grep -E 'full script' $out.log | cut -c1-120)"
    sleep 3
  done
done
