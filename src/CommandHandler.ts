import { App } from "./App";
import { AvaKeystoreUser } from "./AvaClient";
import { log } from "./AppLog";
import { Debug } from "./Debug";
import { OutputPrinter } from "./OutputPrinter";
import { BN } from "bn.js"
import { StringUtility } from "./StringUtility";
import 'reflect-metadata'
import { PendingTxState } from "./PendingTxService";
import * as moment from 'moment';

class FieldSpec {
    constructor(public name:string, public isRequired=true) {

    }

    get toHelpString() {
        if (this.isRequired) {
            return `<${this.name}>`
        } else {
            return `[${this.name}]`
        }
    }
}

class CommandSpec {
    context: string
    countRequiredFields = 0

    constructor(public name: string, public fields: FieldSpec[], public description:string) {
        for (let field of fields) {
            if (field.isRequired) {
                this.countRequiredFields++
            }
        }
    }

    validateInput(...params) {
        if (params.length != this.countRequiredFields) {
            return false
        }

        return true
    }

    printUsage(prefix="") {
        let out = `${this.name}`
        let fieldStrs = []

        for (let field of this.fields) {
            fieldStrs.push(field.toHelpString)
        }

        if (fieldStrs.length) {
            out += " " + fieldStrs.join(" ")
        }
        
        console.log(`${prefix}${out}`)
        console.log(`${prefix}- ${this.description}`)
        console.log()
    }

    get id() {
        return `${this.context}_${this.name}`
    }
}

const commandsMetadata = Symbol("commands");

export function command(definition: any) {
    // log.error(`defining column`, definition)
    // return a function that binds the property name to metadata input (definition)
    return (target: object, propertyKey: string) => {
        let properties: {} = Reflect.getMetadata(commandsMetadata, target);

        if (properties) {
            properties[propertyKey] = definition;
        } else {
            properties = {}
            properties[propertyKey] = definition;
            Reflect.defineMetadata(commandsMetadata, properties, target);
        }
    }
}

export class CommandError extends Error {
    code: any;
    constructor(message, code) {
        super(message);
        this.code = code
        this.name = this.constructor.name;

        Object.setPrototypeOf(this, CommandError.prototype);
    }
}


export class InfoCommandHandler {
    nodeId() {
        console.log(App.avaClient.nodeId)
        return App.avaClient.nodeId
    }
}

export class KeystoreCommandHandler {
    async listUsers() {
        let usernames = await App.ava.NodeKeys().listUsers()
        if (!usernames || !usernames.length) {
            console.log("No users found")
            return
        }

        console.log(`${usernames.length} users found:`)
        for (let name of usernames) {
            console.log(name)
        }

        // return res
    }

    @command(new CommandSpec("createUser", [new FieldSpec("username"), new FieldSpec("password")], "Creates a user in the node’s database."))
    async createUser(username, password) {
        let user = await App.ava.NodeKeys().createUser(username, password)
        App.avaClient.keystoreCache.addUser(new AvaKeystoreUser(username, password))
        log.info(`created user: ${username}`)
    }
    
    @command(new CommandSpec("setUser", [new FieldSpec("username"), new FieldSpec("password")], "Sets the active user for future avm commands"))
    async setUser(username:string, password?:string) {
        App.avaClient.keystoreCache.addUser(new AvaKeystoreUser(username, password), true)
    }
}

export class PlatformCommandHandler {
    _getActiveUser() {
        let user = App.avaClient.keystoreCache.getActiveUser()
        if (!user) {
            console.log("Set active user first with setUser")
        }

        return user
    }

    async createAccount() {
        let user = this._getActiveUser()
        if (!user) {
            return
        }
        
        let res = await App.ava.Platform().createAccount(user.username, user.password)
        log.info(`created`, res)
        console.log("Created platform account: " + res)
    }

    async listAccounts() {
        let user = this._getActiveUser()
        if (!user) {
            return
        }

        let res = await App.ava.Platform().listAccounts(user.username, user.password)
        if (!res || !res.length) {
            console.log("No accounts found")
            return
        }

        console.log(OutputPrinter.pprint(res))
    }

    @command(new CommandSpec("getAccount", [new FieldSpec("address")], "Fetch P-Chain account by address"))
    async getAccount(address:string) {
        let res = await App.ava.Platform().getAccount(address)
        console.log(OutputPrinter.pprint(res))
        return res
    }

    @command(new CommandSpec("importAva", [new FieldSpec("dest"), new FieldSpec("payerNonce", false)], "Finalize a transfer of AVA from the X-Chain to the P-Chain."))
    async importAva(dest: string, payerNonce:number) {
        let user = this._getActiveUser()
        if (!user) {
            return
        }

        if (!payerNonce) {
            payerNonce = await this.getNextPayerNonce(dest)
        }

        let res = await App.ava.Platform().importAVA(user.username, user.password, dest, payerNonce)

        console.log("Issuing Transaction...")
        console.log(res)
        
        await this.issueTx(res)
        
    }

    async getNextPayerNonce(dest:string) {
        let account = await this.getAccount(dest)
        if (!account) {
            throw new Error("Cannot find account " + dest)
        } else {
            return +account["nonce"] + 1
        }
    }

    @command(new CommandSpec("exportAva", [new FieldSpec("amount"), new FieldSpec("x-dest"), new FieldSpec("payerNonce")], "Send AVA from an account on the P-Chain to an address on the X-Chain."))
    async exportAva(dest: string, amount: number, payerNonce:number) {        
        payerNonce = +payerNonce
        if (isNaN(payerNonce)) {
            console.error("Invalid payer nonce: " + payerNonce)
            return
        }

        // remove any prefix X-
        let dparts = dest.split("-")
        if (dparts.length > 1) {
            dest = dparts[1]
        }

        let res = await App.ava.Platform().exportAVA(amount, dest, payerNonce)

        console.log("Issuing Transaction...")
        console.log(res)

        await this.issueTx(res)
    }

    @command(new CommandSpec("issueTx", [new FieldSpec("tx")], "Issue a transaction to the platform chain"))
    async issueTx(tx: string) {
        let txId = await App.ava.Platform().issueTx(tx)
        console.log("result txId: " + txId)
    }

    @command(new CommandSpec("addDefaultSubnetValidator", [new FieldSpec("destination"), new FieldSpec("stakeAmount"), new FieldSpec("endTimeDays")], "Add current node to default subnet (sign and issue the transaction)"))
    async addDefaultSubnetValidator(destination: string, stakeAmount:number, endTimeDays:number) {
        let now = moment().seconds(0).milliseconds(0)
        let startTime = now.clone().add(1, "minute")

        let endTime = now.clone().add(endTimeDays, "days")

        let payerNonce = await this.getNextPayerNonce(destination)

        let args = [App.avaClient.nodeId,
            startTime.toDate(),
            endTime.toDate(),
            new BN(stakeAmount),
            payerNonce,
            destination]
        // log.info("ddx add", Debug.pprint(args))

        let unsignedTx = await App.ava.Platform().addDefaultSubnetValidator(
            App.avaClient.nodeId, 
            startTime.toDate(), 
            endTime.toDate(), 
            new BN(stakeAmount),
            payerNonce, 
            destination)

        console.log("signing transaction: ", unsignedTx)

        let user = this._getActiveUser()
        if (!user) {
            return
        }

        let signedTx = await App.ava.Platform().sign(user.username, user.password, unsignedTx, destination)

        console.log("issuing signed transaction: ", signedTx)
        
        let res = await this.issueTx(signedTx)
        
    }

    @command(new CommandSpec("getPendingValidators", [new FieldSpec("subnetId", false)], "List pending validator set for a subnet, or the Default Subnet if no subnetId is specified"))
    async getPendingValidators(subnetId?) {
        let pv = await App.ava.Platform().getPendingValidators(subnetId)
        console.log(pv)
    }

    @command(new CommandSpec("getCurrentValidators", [new FieldSpec("subnetId", false)], "List current validator set for a subnet, or the Default Subnet if no subnetId is specified"))
    async getCurrentValidators(subnetId?) {
        let pv = await App.ava.Platform().getCurrentValidators(subnetId)
        console.log(pv)
    }

}

export class AvmCommandHandler {
    _getActiveUser() {
        let user = App.avaClient.keystoreCache.getActiveUser()
        if (!user) {
            console.log("Set active user first with setUser")
        }

        return user
    }

    @command(new CommandSpec("importAva", [new FieldSpec("dest")], "Finalize a transfer of AVA from the P-Chain to the X-Chain."))
    async importAva(dest: string) {
        let user = this._getActiveUser()
        if (!user) {
            return
        }

        let res = await App.ava.AVM().importAVA(user.username, user.password, dest)
        console.log("Submitted transaction: " + res)
        App.pendingTxService.add(res)
    }
    
    @command(new CommandSpec("exportAva", [new FieldSpec("dest"), new FieldSpec("amount")], "Send AVA from the X-Chain to an account on the P-Chain."))
    async exportAva(dest:string, amount:number) {
        let user = this._getActiveUser()
        if (!user) {
            return
        }

        let res = await App.ava.AVM().exportAVA(user.username, user.password, dest, amount)
        console.log("Submitted transaction: " + res)
        App.pendingTxService.add(res)
    }

    async listAddresses() {
        let user = this._getActiveUser()
        if (!user) {
            return
        }
        
        let res = await App.ava.AVM().listAddresses(user.username, user.password)

        console.log("Addresses for keystore: " + user.username)
        if (!res || !res.length) {
            console.log("None found")
            return
        }
        
        for (let address of res) {
            console.log(address)
        }
    }

    async listBalances() {
        let user = this._getActiveUser()
        if (!user) {
            return
        }
        
        let res = await App.ava.AVM().listAddresses(user.username, user.password)

        console.log("Addresses for keystore: " + user.username)
        if (!res || !res.length) {
            console.log("None found")
            return
        }
        
        for (let address of res) {
            await this.getAllBalances(address)
        }
    }

    async createAddress() {
        let user = this._getActiveUser()
        if (!user) {
            return
        }

        // log.info("ddx active", user)        
        let res = await App.ava.AVM().createAddress(user.username, user.password)
        console.log("Created Address:")
        console.log(res)
    }

    // async getBalance() {
    //     let res = await App.ava.AVM().getAllBalances()
    //     log.info("res", res)
    // }

    // async setActiveUser(username: string, password?: string) {
    //     console.log(`Set active user: ${username}`)
    //     App.avaClient.keystoreCache.addUser(new AvaKeystoreUser(username, password), true)
    // }

    @command(new CommandSpec("getBalance", [new FieldSpec("address"), new FieldSpec("asset", false)], "Get the balance of an asset in an account"))
    async getBalance(address:string, asset:string="AVA") {
        let bal = await App.ava.AVM().getBalance(address, asset) as BN
        console.log(`Balance on ${address} for asset ${asset}: ` + bal.toString(10))
        // console.log(OutputPrinter.pprint(bal))
    }

    @command(new CommandSpec("getAllBalances", [new FieldSpec("address")], "Get the balance of all assets in an account"))
    async getAllBalances(address) {
        let bal = await App.ava.AVM().getAllBalances(address)
        console.log(`Balance on ${address} for all assets`)
        console.log(OutputPrinter.pprint(bal))
    }

    @command(new CommandSpec("send", [new FieldSpec("fromAddress"), new FieldSpec("toAddress"), new FieldSpec("amount"), new FieldSpec("asset", false)], "Sends asset from an address managed by this node's keystore to a destination address"))
    async send(fromAddress:string, toAddress:string, amount:number, asset="AVA") {
        log.info("ddx", this)
        let user = this._getActiveUser()
        if (!user) {
            return
        }

        let res = await App.ava.AVM().send(user.username, user.password, asset, amount, toAddress, [fromAddress])
        // console.log(`Balance on ${address} for all assets`)
        console.log("submitted transaction...")
        console.log(res)
        App.pendingTxService.add(res)
    }

    @command(new CommandSpec("checkTx", [new FieldSpec("txId")], "Check the status of a transaction id"))
    async checkTx(txId:string) {
        let res = await App.ava.AVM().getTxStatus(txId)
        console.log("Transaction state: " + res)
    }

    @command(new CommandSpec("listTxs", [], "Show the status transactions that have been submitted in this session"))
    async listTxs() {
        let ptxs = App.pendingTxService.list()
        if (!ptxs.length) {
            console.log("No transactions submitted")
            return
        }
        
        console.log("Submitted transactions")
        for (let tx of ptxs) {
            console.log(`${tx.id}\t\t${tx.ts.fromNow()}\t\t${tx.state || PendingTxState.Processing}`)
        }
    }
}

export enum CommandContext {
    Info = "info",
    Keystore = "keystore",
    AVM = "avm",
    Platform = "platform"
}

const META_COMMANDS = [
    "help",
    "exit"
]

export class CommandHandler {
    infoHandler: InfoCommandHandler
    keystoreHandler: KeystoreCommandHandler
    avmHandler: AvmCommandHandler
    platformHandler: PlatformCommandHandler
    handlerMap
    activeContext: string
    commandSpecMap:{[key:string]: CommandSpec} = {}

    contextMethodMap:{[key:string]:string[]} = {}

    constructor() {
        // log.info("init CommandHandler")
        this.infoHandler = new InfoCommandHandler()
        this.keystoreHandler = new KeystoreCommandHandler()
        this.avmHandler = new AvmCommandHandler()
        this.platformHandler = new PlatformCommandHandler()

        this.addCommandSpec(this.keystoreHandler, CommandContext.Keystore)        
        this.addCommandSpec(this.infoHandler, CommandContext.Info)        
        this.addCommandSpec(this.avmHandler, CommandContext.AVM)        
        this.addCommandSpec(this.platformHandler, CommandContext.Platform)        

        // log.info("commandSpecMap", this.commandSpecMap)

        this.handlerMap = {
            "info": this.infoHandler,
            "keystore": this.keystoreHandler,
            "avm": this.avmHandler,
            "platform": this.platformHandler
        }

        for (let context in this.handlerMap) {
            this.contextMethodMap[context] = []

            for (var m in this.handlerMap[context]) {
                // log.info("ddx", m)
                if (m.startsWith("_")) {
                    continue
                }

                this.contextMethodMap[context].push(m)
            }            
        }
    }

    addCommandSpec(obj, context:string) {
        let map = Reflect.getMetadata(commandsMetadata, obj)
        for (let commandName in map) {            
            map[commandName].context = context
            this.commandSpecMap[map[commandName].id] = map[commandName]
        }
    }

    getTopLevelCommands() {
        let out = []
        for (let cmd of META_COMMANDS) {
            out.push(cmd)
        }

        for (let context in this.handlerMap) {
            out.push(context)
        }

        // log.info("tlc", out)
        return out
    }

    getContextCommands(context) {
        let out = []

        for (let cmd of this.contextMethodMap[context] || []) {
            out.push(cmd)
        }

        for (let cmd of META_COMMANDS) {
            out.push(cmd)
        }

        return out
    }

    printHelp(targetContext) {
        targetContext = targetContext || this.activeContext
        console.log("-------------------")
        console.log("SUPPORTED COMMANDS:")
        console.log("-------------------")
        for (let context in this.contextMethodMap) {
            if (targetContext && context != targetContext) {
                continue
            } else {
                console.log(context)
            }
            
            for (let method of this.contextMethodMap[context]) {
                let commandSpec = this.getCommandSpec(context, method)
                if (commandSpec) {
                    commandSpec.printUsage("    ")
                } else {
                    console.log(`    ${method}`)
                    console.log()
                }                
            }

            console.log("")
        }
    }

    printHelpBasic() {
        console.error("Invalid command. Type help to see all supported commands")
    }

    isContext(context) {
        return this.handlerMap[context]
    }

    getCommandSpec(context, method) {
        let commandId = `${context}_${method}`
        return this.commandSpecMap[commandId]
    }

    async handleCommand(cmd:string) {
        let params = StringUtility.splitTokens(cmd)

        if (params.length < 1) {
            this.printHelpBasic()
            return
        }

        if (params.length == 1 && params[0] == "help") {
            this.printHelp(null)
            return
        } else if (params.length == 2 && this.isContext(params[0]) && params[1] == "help") {
            this.printHelp(params[0])
            return
        }
        
        let context = this.activeContext

        if (!context) {
            if (params.length < 2) {
                this.printHelpBasic()
                return
            }

            context = params.shift()
        }

        let handler = this.handlerMap[context]
        if (!handler) {
            throw new CommandError("Unknown context: " + context, "not_found")
        }

        let method = params.shift()
        let methodFn = handler[method]
        if (!methodFn) {
            throw new CommandError(`Unknown method ${method} in context ${context}`, "not_found")
        }
        
        let commandSpec = this.getCommandSpec(context, method)
        if (commandSpec && !commandSpec.validateInput(...params)) {
            console.log("Invalid Arguments")
            commandSpec.printUsage("Usage: ")
            return
        }

        try {
            await methodFn.call(handler, ...params)
        } catch (error) {
            log.error(error)
        }
    }

}
