
## Problems:

- Currently, the AI Agentic has many tools that can create a Knowledge Wiki, or Second Brain. They can indexing the file like `GitNexus`, or build the Graph knowledge like `Graphify` . But it does not the mapping functionality to feed these knowledge to the AI Agentic.
- When starting some AI Agentic, it will enter the fresh context window, and the agent is lost, hallucination is very high when we does not provide the correct references, specs, etc.
- That will make AI agents do the work and create more mistake, even the specs is fine and the prompt of user is detailed
- Therefore, the knowledge to feed the AI is very important. They can avoid create bugs, saving tokens, and they will know what they are doing.

## Goals:
- So, choosing the appropriate knowledge for AI is very important. In this project, I want to build this project like a second brain, which can be feed the knowledge to AI in the middle, when user using the AI Agentic tools
- I also want to teaching AI agentic tools to self-learn, they will know me well through my conversation, and learning about it which will not make the same mistake twice.
- We need to solve the mapping the knowledge problem on the current AI flow.

## The project spec:

### About Prompt action, working with AI Agents:
- I need AI have a reflect skill, that will automatically save the learnings and new skills through the current conversation
	- After completing a complex task (some tool calls) successfully
	- when it hit errors or dead ends and found the working path
	- when the user corrected it approach
	- when it discovered a non-trivial workflow
- When it save the new learning file, tell the AI Agents to label the work, make it normalized that we will save to the DB, that's maybe provide the better context for mapping knowledge to feed AI Agent
- When starting the new session, after user prompted the first prompt, ensure the Agentic hit the DB, query the best knowledge to use, or do something else that can refer/ detect the best knowledge for the prompt. What they want agent to do, what is the goal here, does the AI has the fully context to do that task with confidently?
- We need the mechanism that can clear the context if user choose the wrong context to feed. If they feedback that is not the appropriate knowledge they want, retry and if not again, fallback to the fresh context window.
- Ensure the agents know context clearly, ask user to dive deeply to get the matching knowledge. Then working on their task.

### About the project deps, other tools that we need, the server:

- There is some features that I think it should work okay:
	- Indexing files, knowledge file also has the ref file.
	- We need to store data to database, as I say, it should labelize/ categorize everything, therefore we need to organize the knowledge by database, not the chaos like graph
	- We can save the fields that user have worked before, area of bussiness logic, save inside Project repo name -> Think about it and design for me the best way to implement that
	- Also apply cache, like redis, when we hit db to query the knowledge
- Now, the things I don't have any clue that is the matching, referencing to retrieve the best knowledge that AI think it okay to use. As the solution architech that fully expreiencing with this problem I need you to suggest me the best way to do that.
- DB, redis, server will run on Docker, that we can run on multiple machine without think about installing error
- A server to CRUD the DB, retrieve the knowledge