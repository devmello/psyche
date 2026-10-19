#!/bin/zsh
# Run the six-case probe for one model across the Ollama endpoints, think off and on,
# then (if a GGUF blob path is given) the same through llama-server --jinja.
# usage: ./run-matrix.sh <ollama-tag> [gguf-path] [repeat]
# Needs `ollama serve` on :11434 and $LLAMA_SERVER_BIN pointing at llama-server.
set -u
cd "${0:A:h}"
model=$1; gguf=${2:-}; repeat=${3:-3}
for think in none medium; do
  for e in ollama-native ollama-openai ollama-anthropic; do
    npx tsx src/run.ts --endpoint $e --model $model --reasoning $think --repeat $repeat --timeout 300
  done
done
# Unload from Ollama before llama-server takes the memory.
curl -s -X POST localhost:11434/api/generate -d "{\"model\":\"$model\",\"keep_alive\":0}" >/dev/null
if [[ -n $gguf ]]; then
  pkill -f "$LLAMA_SERVER_BIN" 2>/dev/null; sleep 2
  "$LLAMA_SERVER_BIN" -m "$gguf" --jinja --host 127.0.0.1 --port 8080 -c 16384 -fa on > results/llama-server.raw.log 2>&1 &
  for i in {1..180}; do curl -s localhost:8080/health | grep -q ok && break; sleep 1; done
  for think in none medium; do
    npx tsx src/run.ts --endpoint llama-server --model $model-gguf --label $model --reasoning $think --repeat $repeat --timeout 300
  done
  npx tsx src/quirks.ts --model $model-gguf --label $model --endpoints llama-server
  pkill -f "$LLAMA_SERVER_BIN"
fi
npx tsx src/quirks.ts --model $model --endpoints ollama-native,ollama-openai,ollama-anthropic
echo "MATRIX-DONE $model"
