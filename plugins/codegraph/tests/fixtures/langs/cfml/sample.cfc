<cfcomponent displayname="Vault" hint="Keeps per-user balances" output="false">

    <cfproperty name="fee" type="numeric" default="0.05">

    <!--- Creates the vault. --->
    <cffunction name="init" access="public" returntype="Vault" output="false">
        <cfset variables.total = 0>
        <cfreturn this>
    </cffunction>

    <!--- Credits an amount for a user. --->
    <cffunction name="deposit" access="public" returntype="numeric" output="false">
        <cfargument name="owner" type="string" required="true">
        <cfargument name="amount" type="numeric" required="true">
        <cfset variables.total += arguments.amount>
        <cfreturn formatAmount(variables.total)>
    </cffunction>

    <cffunction name="formatAmount" access="private" returntype="numeric" output="false">
        <cfargument name="value" type="numeric" required="true">
        <cfreturn dollarFormat(arguments.value)>
    </cffunction>

    <cfscript>
        // Logs a deposit line.
        function logDeposit(string owner) {
            writeLog(text="deposit by " & owner);
        }
    </cfscript>

    <cfinclude template="helpers.cfm">

</cfcomponent>
