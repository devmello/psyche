| model | endpoint | think | single | parallel | follow-up | json | plan | refuse | score | verdict | tok/s | TTFT ms | median case s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gemma4:12b | ollama-anthropic | medium | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 6/6 | **agent-capable** | 34.6 | 285 | 8.1 |
| gemma4:12b | ollama-anthropic | none | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 6/6 | **agent-capable** | 23.7 | 149 | 2.0 |
| gemma4:12b | ollama-native | medium | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | 5/6 | chat-only | 33.0 | 273 | 11.1 |
| gemma4:12b | ollama-native | none | 2/2 | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | 5/6 | chat-only | 23.2 | 185 | 2.0 |
| gemma4:12b | ollama-openai | medium | 2/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 5/6 | chat-only | 22.4 | 523 | 7.0 |
| gemma4:12b | ollama-openai | none | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 6/6 | **agent-capable** | 21.6 | 120 | 2.6 |
| gpt-oss:20b | ollama-anthropic | medium | 1/1 | 0/1 | 1/1 | 0/1 | 0/1 | 1/1 | 3/6 | chat-only | – | – | 300.8 |
| gpt-oss:20b | ollama-native | none | 3/3 | 0/3 | 3/3 | 2/3 | 0/3 | 3/3 | 3/6 | chat-only | 6.5 | 1709 | 66.7 |
| gpt-oss:20b | ollama-openai | medium | 1/1 | 0/1 | 0/1 | 0/1 | 0/1 | 1/1 | 2/6 | chat-only | – | – | 300.7 |
| qwen3.5:0.8b | llama-server | medium | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 | 1/3 | 3/6 | chat-only | 96.2 | 36 | 5.1 |
| qwen3.5:0.8b | llama-server | none | 3/3 | 3/3 | 3/3 | 2/3 | 0/3 | 0/3 | 3/6 | chat-only | 103.6 | 56 | 2.0 |
| qwen3.5:0.8b | ollama-anthropic | medium | 3/3 | 3/3 | 2/3 | 2/3 | 0/3 | 0/3 | 2/6 | chat-only | 30.3 | 161 | 6.5 |
| qwen3.5:0.8b | ollama-anthropic | none | 3/3 | 3/3 | 2/3 | 0/3 | 0/3 | 0/3 | 2/6 | chat-only | 43.7 | 56 | 2.8 |
| qwen3.5:0.8b | ollama-native | medium | 2/3 | 2/3 | 2/3 | 0/3 | 0/3 | 0/3 | 0/6 | chat-only | 92.0 | 53 | 1.1 |
| qwen3.5:0.8b | ollama-native | none | 3/3 | 3/3 | 1/3 | 0/3 | 0/3 | 0/3 | 2/6 | chat-only | 51.9 | 627 | 3.3 |
| qwen3.5:0.8b | ollama-openai | medium | 3/3 | 2/3 | 3/3 | 0/3 | 0/3 | 0/3 | 2/6 | chat-only | 49.5 | 442 | 8.1 |
| qwen3.5:0.8b | ollama-openai | none | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 | 3/6 | chat-only | 19.1 | 252 | 6.8 |
| qwen3.5:9b | llama-server | medium | 3/3 | 3/3 | 3/3 | 2/3 | 2/3 | 3/3 | 4/6 | chat-only | 23.1 | 68 | 14.5 |
| qwen3.5:9b | llama-server | none | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 6/6 | **agent-capable** | 23.2 | 68 | 3.1 |
| qwen3.5:9b | ollama-anthropic | medium | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 | 3/3 | 4/6 | chat-only | 26.8 | 139 | 8.2 |
| qwen3.5:9b | ollama-anthropic | none | 3/3 | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 | 5/6 | chat-only | 18.7 | 1703 | 6.0 |
| qwen3.5:9b | ollama-native | medium | 3/3 | 3/3 | 2/3 | 3/3 | 2/3 | 3/3 | 4/6 | chat-only | 17.6 | 34382 | 21.2 |
| qwen3.5:9b | ollama-native | none | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 6/6 | **agent-capable** | 25.1 | 270 | 3.1 |
| qwen3.5:9b | ollama-openai | medium | 3/3 | 3/3 | 1/3 | 3/3 | 1/3 | 3/3 | 4/6 | chat-only | 25.8 | 144 | 9.4 |
| qwen3.5:9b | ollama-openai | none | 3/3 | 3/3 | 3/3 | 1/3 | 3/3 | 2/3 | 4/6 | chat-only | 25.5 | 87 | 4.5 |

### Failure reasons

- **gemma4:12b · ollama-native · medium**
  - plan: work order make_dir>make_dir>write_file>run_command>run_command>run_command>run_command>run_command>run_command>run_command>run_command>run_command>run_command;
  - plan: work order make_dir>make_dir>write_file>run_command>run_command>run_command>run_command>run_command>schedule_cron>run_command
- **gemma4:12b · ollama-native · none**
  - plan: work order make_dir>write_file>schedule_cron; final checklist not all done; no final summary (×2)
- **gemma4:12b · ollama-openai · medium**
  - parallel: expected 2 calls in step 1, got 1; timezone=undefined (×2)
- **gpt-oss:20b · ollama-anthropic · medium**
  - parallel: expected 2 calls in step 1, got 1; timezone=undefined
  - json: no valid object: The operation was aborted due to timeout; title=undefined; priority=undefined; due=undefined; tags=
  - plan: first call was undefined; initial checklist 0 items; work order ; only 0 checklist updates; final checklist not all done; cron=undefined; script lacks rsync; no
- **gpt-oss:20b · ollama-native · none**
  - parallel: expected 2 calls in step 1, got 1; timezone=undefined (×3)
  - plan: tool error: update_checklist: AI_InvalidToolInputError: Invalid input for tool update_checklist: AI_TypeValidationError: Type validation failed: Value: {"items" (×2)
  - plan: first call was undefined; initial checklist 0 items; work order ; only 0 checklist updates; final checklist not all done; cron=undefined; script lacks rsync; no
  - json: tool error: task.create: AI_NoSuchToolError: Model tried to call unavailable tool 'task.create'. No tools are available.; no valid object: No object generated: 
- **gpt-oss:20b · ollama-openai · medium**
  - parallel: expected 2 calls in step 1, got 1; timezone=undefined
  - follow-up: lookup_order(4471) missing; track_package not called after lookup result; tracking_number=undefined; carrier=undefined; final answer does not mention Reno
  - json: no valid object: The operation was aborted due to timeout; title=undefined; priority=undefined; due=undefined; tags=
  - plan: first call was undefined; initial checklist 0 items; work order ; only 0 checklist updates; final checklist not all done; cron=undefined; script lacks rsync; no
- **qwen3.5:0.8b · llama-server · medium**
  - json: no valid object: No object generated: could not parse the response.; title=undefined; priority=undefined; due=undefined; tags= (×3)
  - plan: work order write_file>schedule_cron>run_command>run_command>run_command>run_command>run_command>run_command; cron=0 2 * * *
  - plan: cron=0 0 1 1 1; no final summary
  - refuse: made calls: get_weather,get_time
  - plan: reasoning tags leaked into text; first call was make_dir; initial checklist 0 items; work order make_dir>write_file>run_command; final checklist not all done; c
  - refuse: made calls: get_time
- **qwen3.5:0.8b · llama-server · none**
  - json: title=Update Travel and Admin
  - plan: work order run_command>run_command>run_command>run_command>run_command>run_command>run_command>run_command; cron=undefined; script lacks rsync; no final summary
  - refuse: made calls: get_weather,get_time
  - plan: only 1 checklist updates; final checklist not all done; cron=0 2 * * *
  - refuse: made calls: get_time,get_weather,get_weather,get_time; no answer
  - plan: work order run_command>run_command>run_command>run_command>run_command; cron=undefined; script lacks rsync; no final summary
  - refuse: made calls: get_weather,get_time,get_weather,get_time,get_weather,get_time; no answer
- **qwen3.5:0.8b · ollama-anthropic · medium**
  - plan: tool error: update_checklist: AI_InvalidToolInputError: Invalid input for tool update_checklist: AI_TypeValidationError: Type validation failed: Value: {"items"
  - refuse: tool error: make_reservation: AI_NoSuchToolError: Model tried to call unavailable tool 'make_reservation'. Available tools: get_weather, get_time.; made calls: 
  - follow-up: final answer does not mention Reno
  - json: title=extract task from note
  - plan: cron=Sunday at 02:00 (every Sunday); no final summary
  - refuse: made calls: get_time,get_weather,get_time; no answer
  - plan: work order run_command>write_file>run_command>run_command>run_command>run_command>run_command>run_command>run_command>write_file>run_command; final checklist no
  - refuse: made calls: get_weather
- **qwen3.5:0.8b · ollama-anthropic · none**
  - json: title=Task; due=2026-10-19T08:00:00
  - plan: tool error: update_checklist: AI_InvalidToolInputError: Invalid input for tool update_checklist: AI_TypeValidationError: Type validation failed: Value: {"items" (×2)
  - refuse: made calls: get_weather,get_time,get_weather; no answer
  - json: title=reminder
  - plan: work order run_command>write_file>run_command>run_command>write_file>run_command>run_command; cron=undefined
  - refuse: made calls: get_weather,get_time,get_time; no answer (×2)
  - follow-up: track_package not called after lookup result; tracking_number=8603055691202; final answer does not mention Reno
  - json: title=Task Extraction; due=2026-10-19
- **qwen3.5:0.8b · ollama-native · medium**
  - json: due=March 3rd 2027
  - plan: only 2 checklist updates; cron=*/7 * * * * /bin/backup.sh
  - refuse: made calls: get_weather,get_weather,get_time; no answer
  - json: error: terminated
  - plan: stream error: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434; first call was undefined; initial checklist 0 items; work order ; only 0 checklist up (×2)
  - refuse: stream error: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434; no answer (×2)
  - single: stream error: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434; expected 1 call, got 0; wrong tool undefined; city=undefined; unit=undefined
  - parallel: stream error: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434; expected 2 calls in step 1, got 0; weather city=undefined; timezone=undefined
  - follow-up: stream error: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434; lookup_order(4471) missing; track_package not called after lookup result; tracking_nu
  - json: stream error: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434; no valid object: No output generated. Check the stream for errors.; title=undefined; 
- **qwen3.5:0.8b · ollama-native · none**
  - json: due=March 3rd, 2027 (×2)
  - plan: work order run_command>run_command>run_command>run_command>run_command>run_command>run_command>run_command; cron=undefined; script lacks rsync; no final summary
  - refuse: made calls: get_time
  - follow-up: track_package not called after lookup result; tracking_number=1Z90D6C15A23810154; final answer does not mention Reno
  - plan: work order run_command>write_file>run_command; cron=undefined; no final summary
  - refuse: tool error: make_booking: AI_NoSuchToolError: Model tried to call unavailable tool 'make_booking'. Available tools: get_weather, get_time.; made calls: get_weat
  - follow-up: track_package not called after lookup result; tracking_number=4690000152023604860; final answer does not mention Reno
  - json: title=Travel & Admin; due=March 3rd, 2027
  - plan: work order run_command; only 2 checklist updates; final checklist not all done; cron=undefined; script lacks rsync
  - refuse: made calls: get_weather,get_time,get_weather; no answer
- **qwen3.5:0.8b · ollama-openai · medium**
  - json: title=Urgent Task Extraction; due=2027-11
  - plan: tool error: update_checklist: AI_InvalidToolInputError: Invalid input for tool update_checklist: AI_TypeValidationError: Type validation failed: Value: {"items" (×2)
  - refuse: made calls: get_weather,get_time,get_weather; no answer
  - parallel: timezone=Europe/Paris
  - json: no valid object: No object generated: could not parse the response.; title=undefined; priority=undefined; due=undefined; tags= (×2)
  - refuse: made calls: get_weather,get_time; no answer
  - plan: initial checklist 0 items; final checklist not all done; cron=* * * * ? 2026-10-19; no final summary
  - refuse: made calls: get_weather,get_time
- **qwen3.5:0.8b · ollama-openai · none**
  - json: due=
  - plan: work order run_command>write_file>schedule_cron>run_command; only 1 checklist updates; final checklist not all done; cron=0 9 * * 7
  - refuse: made calls: get_weather,get_time (×2)
  - json: title=Travel; due=March 3rd, 2027; tags=travel
  - plan: tool error: update_checklist: AI_InvalidToolInputError: Invalid input for tool update_checklist: AI_TypeValidationError: Type validation failed: Value: {"items"
  - refuse: made calls: get_time
  - json: title=Urgent; due=March 3, 2026
  - plan: work order write_file>schedule_cron; only 2 checklist updates; final checklist not all done; cron=*/Sun - 02:00
- **qwen3.5:9b · llama-server · medium**
  - plan: work order make_dir>write_file>run_command>run_command>run_command>run_command>run_command>run_command>schedule_cron>run_command>schedule_cron>run_command>run_c
  - json: title=add_reminder
- **qwen3.5:9b · ollama-anthropic · medium**
  - follow-up: final answer does not mention Reno (×3)
  - plan: work order make_dir>write_file>run_command>make_dir>run_command>run_command>run_command>run_command>write_file>run_command>run_command>run_command>run_command>w
  - plan: work order make_dir>write_file>run_command>run_command>run_command>run_command>write_file>run_command>write_file>run_command>run_command>run_command>run_command
  - plan: tool error: update_checklist: AI_InvalidToolInputError: Invalid input for tool update_checklist: AI_TypeValidationError: Type validation failed: Value: {"items"
- **qwen3.5:9b · ollama-anthropic · none**
  - follow-up: tracking_number=1Z9X4E77031234567; final answer does not mention Reno
- **qwen3.5:9b · ollama-native · medium**
  - plan: tool error: update_checklist: AI_InvalidToolInputError: Invalid input for tool update_checklist: AI_TypeValidationError: Type validation failed: Value: {"items"
  - follow-up: tracking_number=1Z9X4E77031234567; final answer does not mention Reno
- **qwen3.5:9b · ollama-openai · medium**
  - follow-up: final answer does not mention Reno (×2)
  - plan: work order make_dir>make_dir>write_file>run_command>schedule_cron>run_command; no final summary
  - plan: work order make_dir>write_file>run_command>run_command>schedule_cron>run_command>write_file>run_command
- **qwen3.5:9b · ollama-openai · none**
  - json: due=2026-03-03
  - json: due=March 3, 2027
  - refuse: made calls: get_weather,get_time
