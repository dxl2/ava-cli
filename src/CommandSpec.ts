import { FieldSpec } from "./CommandHandler";
import { App } from "./App";
import { BN } from "bn.js"
import { log } from "./AppLog";
import * as fs from 'fs';
import * as path from 'path';
import { JsonFile } from "./JsonFile";
import { ValueFormatter } from "./ValueFormatter";

export enum CommandSpecDataType {
    String = "string",
    NumberArray = "Array<number>",
    StringArray = "Array<string>",
    BigNumber = "BN",
    Date = "Date",
    JsonFile = "JsonFile"
}

export class CommandParamSpec {
    name:string
    desc:string
    type:string
    optional:boolean
    hidden = false

    constructor(data) {
        Object.assign(this, data)
    }

    sanitize(v) {
        if (this.type == CommandSpecDataType.String) {
            return v
        } else if (this.type == CommandSpecDataType.NumberArray) {
            return ValueFormatter.asNumberArray(v)
        } else if (this.type == CommandSpecDataType.StringArray) {
            return ValueFormatter.asStringArray(v)
        } else if (this.type == CommandSpecDataType.BigNumber) {
            return new BN(v)
        } else if (this.type == CommandSpecDataType.Date) {
            return new Date(+v * 1000)
        }
        
        else {
            throw new Error ("Unknown type:" + this.type)
        }
    }
}

export class CommandSpecManager {    
    static async loadSpecs() {
        let specs = []
        const specDir = path.resolve(__dirname, "..", "specs")
        for (let context of fs.readdirSync(specDir)) {
            let contextDir = specDir + path.sep + context
            for (let specFile of fs.readdirSync(contextDir)) {
                // log.info(`loading ${contextDir} ${specFile}`)
                let specFilePath = contextDir + path.sep + specFile
                let jf = new JsonFile(specFilePath)
                let data = await jf.read()
                let spec = new CommandSpec2(context, data)
                specs.push(spec)
            }
        }

        return specs
    }
}

export class CommandSpec2 {
    name:string
    desc:string
    output:CommandSpecDataType
    params: CommandParamSpec[] = []
    nameParamMap: {[key:string]: CommandParamSpec} = {}
    useKeystore = false

    constructor(public context, data) {
        Object.assign(this, data)

        this.params = []
        for (let param of data.params) {
            let s = new CommandParamSpec(param)
            this.params.push(s)
            this.nameParamMap[param.name] = s
        }

        // check if this param requires keystore
        if (this.nameParamMap["username"] && this.nameParamMap["password"]) {
            this.useKeystore = true

            this.nameParamMap["username"].hidden = true
            this.nameParamMap["username"].optional = true
            
            this.nameParamMap["password"].hidden = true
            this.nameParamMap["password"].optional = true
        }
    }

    formatOutput(o) {
        if (this.output == CommandSpecDataType.BigNumber) {
            return o.toString(10)
        } else {
            return o
        }
    }

    get requiredParameterCount() {
        let o = 0
        for (let p of this.params) {
            if (!p.optional) {
                o++
            }
        }

        return o
    }

    isKeystoreUserParam(param:CommandParamSpec) {
        return this.useKeystore && param.name == "username"
    }

    isKeystorePasswordParam(param:CommandParamSpec) {
        return this.useKeystore && param.name == "password"
    }

    async validateInput(rawValues) {
        if (rawValues.length < this.requiredParameterCount) {
            console.error(`Error: Requires at least ${this.requiredParameterCount} parameters`)
            return null
        }

        let user = App.avaClient.keystoreCache.getActiveUser()

        let sanitizedInput = []
        let valueIndex = 0
        for (let i=0; i<this.params.length; i++) {
            let param = this.params[i]

            if (this.isKeystoreUserParam(param)) {
                sanitizedInput.push(user.username)
            } else if (this.isKeystorePasswordParam(param)) {
                sanitizedInput.push(user.password)
            }
            else if (rawValues[valueIndex]) {
                let sanitized

                if (param.type == CommandSpecDataType.JsonFile) {
                    sanitized = await new JsonFile(rawValues[valueIndex]).read()
                } else {
                    sanitized = param.sanitize(rawValues[valueIndex])
                }                

                if (!sanitized) {
                    console.error(`Invalid input ${rawValues[valueIndex]} for field ${param.name}`)
                    return null
                }

                sanitizedInput.push(sanitized)
                valueIndex++
            } else {
                sanitizedInput.push(undefined)
            }
        }

        return sanitizedInput
    }

    getApiEndpoint() {
        if (this.context == "avm") {
            return App.ava.XChain()
        } else if (this.context == "platform") {
            return App.ava.PChain()
        } else if (this.context == "auth") {
            return App.ava.Auth()
        } else if (this.context == "contract") {
            return App.ava.CChain()
        } else if (this.context == "admin") {
            return App.ava.Admin()
        }
        else {
            throw new Error("Unknown endpoint: " + this.context)
        }
    }

    async run(params) { 
        let data = await this.validateInput(params)
        if (!data) {          
            console.error("Error: invalid input")
            this.printUsage()
            return
        }

        let ep = this.getApiEndpoint()
        let res = await ep[this.name](...data)

        res = this.formatOutput(res)

        console.log(res)
    }

    requireKeystore() {
        return this.useKeystore
    }

    get visibleParams() {
        let out = []
        for (let p of this.params) {
            if (p.hidden) {
                continue
            }
            out.push(p)
        }

        return out
    }

    printUsage(prefix = "", noOutput=false) {
        let out = `${this.name}`
        let fieldNames = []

        for (let field of this.visibleParams) {
            if (field.optional) {
                fieldNames.push(`(${field.name})`)
            } else {
                fieldNames.push(`<${field.name}>`)
            }            
        }

        if (fieldNames.length) {
            out += " " + fieldNames.join(" ")
        }

        let outLines = []
        outLines.push(`${prefix}${out}`)
        outLines.push(`${prefix}+ ${this.desc}`)
        
        for (let p of this.visibleParams) {
            let meta = ""
            if (p.optional) {
                meta = " (optional)"
            }

            outLines.push(`${prefix}${prefix}- ${p.name}${meta}: ${p.desc}`)
        }

        outLines.push("")

        let fout = outLines.join("\n")
        if (!noOutput) {
            console.log(fout)
        }

        return fout
    }
}
