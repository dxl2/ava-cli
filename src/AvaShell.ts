const repl = require('repl');
import * as avalanche from "avalanche";
import BN from 'bn.js';
import { Buffer } from 'buffer/'
import { App } from "./App";
import { CommandHandler, CommandContext } from "./CommandHandler";
import { log } from "./AppLog";
import { StringUtility } from "./StringUtility";
import { AppRuntime } from "./AppRuntime";
import "./Custom";
import { CommandPromptHandler, CommandPrompt, CommandPromptQuestion } from "./CommandPrompt";
import { CommandRegistry } from "./CommandRegistry";

let replServer

export class CommandPromptHandlerImpl implements CommandPromptHandler {
    isPrompting
    isCancelled

    constructor(private rl) {
        rl.on('SIGINT', () => {
            if (this.isPrompting) {
                console.log("Hit <enter> to cancel prompt")
                this.isCancelled = true
            }
        });
    }

    async prompt(prompt: CommandPrompt): Promise<boolean> {
        this.isPrompting = true
        this.isCancelled = false
        for (let q of prompt.questions) {
            await this.promptQuestion(q)

            if (this.isCancelled) {
                break
            }
        }

        let out = this.isCancelled ? false : true
        this.isCancelled = false
        this.isPrompting = false
        this.rl.displayPrompt(true)
        return out
    }

    async promptQuestion(q: CommandPromptQuestion) {
        return new Promise((resolve, reject) => {
            this.rl.question(`${q.question}: `, (answer) => {
                q.answer = answer
                resolve()
            })
        })
    }
}

export class AvaShell {
    static init() {
        App.pendingTxService.setCallback((txid)=> {
            console.log(`\nTransaction ${txid} accepted`)
            replServer.displayPrompt(true)
        })
    }

    static async evalHandler(cmd:string, context, filename, callback) {        
        try {
            cmd = cmd.trim()
            if (!cmd) { 
                callback(null, null)
                return
            }

            if (cmd == "exit") {
                if (App.commandHandler.activeContext) {
                    App.commandHandler.activeContext = null
                    this.updatePrompt()
                    callback(null, null)
                    return
                } else {
                    console.log("Exiting...")
                    process.exit()                    
                }
            } else if (App.commandHandler.isContext(cmd) && App.commandHandler.activeContext != cmd) {
                App.commandHandler.activeContext = cmd
                this.updatePrompt()
                callback(null, null)
                return
            }
            
            let res = await App.commandHandler.handleCommand(cmd)
            this.updatePrompt()
            callback(null, res)
        } catch(error) {
            log.error(error)
            if (error.message) {
                callback(null, `Error: ${error.message}`)
            } else {
                callback(null, `Unexpected error`)
            }
        }
    }

    static updatePrompt() {
        let prompt = "ava"
        
        let activeUsername = App.avaClient.keystoreCache.activeUsername
        if (activeUsername) {
            prompt = `${activeUsername}@ava`
        }

        if (App.commandHandler.activeContext) {
            prompt = `${prompt} ${App.commandHandler.activeContext}`
        }
        prompt += "> "
        replServer.setPrompt(prompt)
    }

    static formatOutput(output) {
        if (output == null) {
            return ""
        }

        return output;
    }

    static appendSeparator(items) {
        let out = items.map(x => `${x} `)
        out.sort
        return out
    }

    static completer(line) {        
        let params = StringUtility.splitTokens(line)
        if (!params.length) {            
            return [params[0], App.commandHandler.getTopLevelCommands()]
        }

        // log.info("in completer", params, params[0])
        if (!App.commandHandler.activeContext) {
            if (params.length == 1) {
                let completions = this.getCompletions(params[0], App.commandHandler.getTopLevelCommands())

                if (App.commandHandler.isContext(params[0])) {
                    return [ App.commandHandler.getContextCommands(params[0]), params[0] ]
                }

                return [this.appendSeparator(completions), params[0]]
            } else {
                let commandSpecLegacy = App.commandHandler.getCommandSpec(params[0], params[1])
                let commandSpec = CommandRegistry.getCommandSpec(params[0], params[1])

                // log.info("ddx cs", commandSpec)
                if (commandSpecLegacy) {
                    console.log("\n")
                    commandSpecLegacy.printUsage()
                    return [[""], line]
                } else if (commandSpec) {
                    console.log("\n")
                    commandSpec.printUsage()
                    return [[""], line]
                }                
                else {
                    let completions = this.getCompletions(params[1], App.commandHandler.getContextCommands(params[0]))
                    return [this.appendSeparator(completions), params[1]]
                }                
            }
        } else {
            if (params.length == 1) {
                let completions = this.getCompletions(params[0], App.commandHandler.getContextCommands(App.commandHandler.activeContext))
                return [this.appendSeparator(completions), params[0]]
            } else {
                return [[], ""]
            }
        }
    }

    static getCompletions(needle:string, haystack:string[]) {
        let matches = haystack.filter((c) => c.startsWith(needle))
        matches.sort()
        return matches
    }
}

function isStandaloneInvocation()
{
    return (process.argv.length > 2)
}

async function main() {
    let isStandalone = isStandaloneInvocation()

    await App.init(isStandalone)
    AvaShell.init()

    if (isStandalone) {
        if (!App.isConnected) {
            console.error("AVA node is not connected")
            return
        }

        // standalone invocation
        let args = process.argv.slice(2)
        await App.commandHandler.handleCommand(args.join(" "))
        process.exit()
    }

    const options = { 
        useColors: true, 
        prompt: 'ava> ', 
        eval: AvaShell.evalHandler.bind(AvaShell), 
        writer: AvaShell.formatOutput.bind(AvaShell),
        completer: AvaShell.completer.bind(AvaShell)
    }
    replServer = repl.start(options);

    App.promptHandler = new CommandPromptHandlerImpl(replServer)
}

main()

process.on('unhandledRejection', async (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    await AppRuntime.sleep(600 * 1000)
});