<cfcomponent displayname="Greeter" output="false">

    <cffunction name="init" access="public" returntype="Greeter">
        <cfargument name="name" type="string" required="true">
        <cfset variables.name = arguments.name>
        <cfreturn this>
    </cffunction>

    <cffunction name="greet" access="public" returntype="string">
        <cfreturn "Hello, #variables.name#!">
    </cffunction>

</cfcomponent>
