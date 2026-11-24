Imports System
Imports System.Collections.Generic
Imports System.Globalization

''' <summary>Fixed-precision money in minor units.</summary>
Public NotInheritable Class Money
    Public Const CentsPerUnit As Integer = 100
    Private ReadOnly currency As String
    Public Property Cents As Long

    Public Sub New(cents As Long, currency As String)
        Me.Cents = cents
        Me.currency = currency
    End Sub

    ''' <summary>Builds a Money from a whole-unit amount.</summary>
    Public Shared Function FromUnits(amount As Double, currency As String) As Money
        Return New Money(CLng(Math.Round(amount * CentsPerUnit)), currency)
    End Function

    Public Function Describe(culture As CultureInfo) As String
        Dim parts As New List(Of String) From {culture.Name, currency}
        Return String.Join(" ", parts) & " " & Cents \ CentsPerUnit
    End Function
End Class

Public Enum Region
    Us
    Eu
End Enum

Module Pricer
    Public Const TaxRate As Double = 0.19
    Public Function Gross(net As Money) As Money
        Return New Money(CLng(net.Cents * (1 + TaxRate)), "USD")
    End Function
End Module
